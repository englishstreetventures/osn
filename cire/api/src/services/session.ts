import { sessions } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";

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
      return { token, expiresAt };
    });
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
    });
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
    });
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
    });
  },
};
