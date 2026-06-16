import { sessions } from "@cire/db";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import { metricSessionCreated } from "../metrics";

export class SessionInvalid extends Data.TaggedError("SessionInvalid")<{
  reason: "missing" | "expired";
}> {}

export class SessionWriteError extends Data.TaggedError("SessionWriteError")<{
  op: "insert" | "delete" | "deleteAllForFamily";
  reason: string;
}> {}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * 256 bits of `crypto.getRandomValues` entropy → base64url (no padding).
 * 43 chars; URL-safe; safe to drop straight into a Set-Cookie header.
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * SHA-256 hex of the raw token. The DB stores the hash so a leaked DB dump
 * cannot be replayed as a session cookie. Cookie still carries the raw token
 * — we hash on every validate/revoke lookup and match that. SHA-256 hex is
 * deterministic so the existing UNIQUE index on `sessions.token` keeps working.
 */
function hashToken(raw: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const data = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export interface ValidatedSession {
  familyId: string;
  expiresAt: Date;
}

export const sessionService = {
  create(
    familyId: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Effect.Effect<CreatedSession, SessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const token = generateToken();
      const tokenHash = yield* hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(sessions)
              .values({
                id: crypto.randomUUID(),
                familyId,
                token: tokenHash,
                expiresAt,
                createdAt: now,
              })
              .run(),
          ),
        catch: (e) => new SessionWriteError({ op: "insert", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("session insert failed", { reason: err.reason })),
      );
      yield* Effect.sync(() => metricSessionCreated("ok"));
      return { token, expiresAt };
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricSessionCreated("error"))),
      Effect.withSpan("cire.session.create"),
    );
  },

  validate(token: string): Effect.Effect<ValidatedSession, SessionInvalid, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (!token) {
        return yield* Effect.fail(new SessionInvalid({ reason: "missing" }));
      }
      const tokenHash = yield* hashToken(token);
      const [row] = yield* dbQuery(() =>
        db.select().from(sessions).where(eq(sessions.token, tokenHash)).all(),
      );
      if (!row) {
        return yield* Effect.fail(new SessionInvalid({ reason: "missing" }));
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return yield* Effect.fail(new SessionInvalid({ reason: "expired" }));
      }
      return { familyId: row.familyId, expiresAt: row.expiresAt };
    }).pipe(Effect.withSpan("cire.session.validate"));
  },

  revoke(token: string): Effect.Effect<void, SessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const tokenHash = yield* hashToken(token);
      yield* Effect.tryPromise({
        try: () => Promise.resolve(db.delete(sessions).where(eq(sessions.token, tokenHash)).run()),
        catch: (e) => new SessionWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("session delete failed", { reason: err.reason })),
      );
    }).pipe(Effect.withSpan("cire.session.revoke"));
  },

  /**
   * Rotate a guest session (C6): mint a fresh token for the same family and
   * revoke the presented one, **atomically in a single D1 batch** so there is
   * never a window where both the old and new token are valid (nor one where
   * neither is). Used after `POST /api/account/link` succeeds — a
   * session-fixation defence: any token an attacker may have planted before the
   * legitimate user linked their OSN account is invalidated in the same commit
   * the new cookie is minted.
   *
   * The old token is matched by SHA-256 hash, the same as `revoke`/`validate`.
   */
  rotate(
    familyId: string,
    oldToken: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Effect.Effect<CreatedSession, SessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const newToken = generateToken();
      const newHash = yield* hashToken(newToken);
      const oldHash = yield* hashToken(oldToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      const insertStmt = db.insert(sessions).values({
        id: crypto.randomUUID(),
        familyId,
        token: newHash,
        expiresAt,
        createdAt: now,
      });
      const deleteStmt = db.delete(sessions).where(eq(sessions.token, oldHash));

      yield* Effect.tryPromise({
        try: () => {
          const batchable = db as {
            batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown>;
          };
          if (typeof batchable.batch === "function") {
            return batchable.batch([insertStmt, deleteStmt]);
          }
          // bun:sqlite (tests/local): no .batch(); run sequentially — insert
          // before delete so the family always has a live session.
          return (async () => {
            await insertStmt;
            await deleteStmt;
          })();
        },
        catch: (e) => new SessionWriteError({ op: "insert", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("session rotate failed", { reason: err.reason })),
      );

      yield* Effect.sync(() => metricSessionCreated("ok"));
      return { token: newToken, expiresAt };
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricSessionCreated("error"))),
      Effect.withSpan("cire.session.rotate"),
    );
  },

  revokeAllForFamily(familyId: string): Effect.Effect<void, SessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(db.delete(sessions).where(eq(sessions.familyId, familyId)).run()),
        catch: (e) => new SessionWriteError({ op: "deleteAllForFamily", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("session deleteAllForFamily failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("cire.session.revokeAllForFamily"));
  },
};
