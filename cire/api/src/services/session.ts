import { sessions } from "@cire/db";
import { generateToken, hashToken } from "@shared/crypto/tokens";
import { rowsChanged } from "@shared/db-utils";
import { and, eq, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import { metricSessionCreated, metricSessionSwept } from "../metrics";

export class SessionInvalid extends Data.TaggedError("SessionInvalid")<{
  reason: "missing" | "expired";
}> {}

export class SessionWriteError extends Data.TaggedError("SessionWriteError")<{
  op: "insert" | "delete" | "deleteAllForFamily" | "sweep" | "setMember";
  reason: string;
}> {}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export interface ValidatedSession {
  familyId: string;
  expiresAt: Date;
  /** The household member this session chose, or null. */
  memberGuestId: string | null;
}

export const sessionService = {
  /**
   * Mint a session for `familyId`. `memberGuestId` is the member it starts
   * with — set only when the claim chose one for a one-member household.
   */
  create(
    familyId: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
    memberGuestId: string | null = null,
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
                memberGuestId,
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
      return {
        familyId: row.familyId,
        expiresAt: row.expiresAt,
        memberGuestId: row.memberGuestId ?? null,
      };
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

      // Insert before delete in the statement list — on the bun:sqlite
      // sequential fallback (no `.batch()`) that keeps the family with a live
      // session at every point, matching the previous by-hand ordering.
      //
      // The new row takes the old row's member inside the same batch, so a
      // "Not you?" that clears it between the request's start and this write
      // is never undone. No old row (already revoked) leaves the member null.
      const statements: BatchItem<"sqlite">[] = [
        db.insert(sessions).values({
          id: crypto.randomUUID(),
          familyId,
          token: newHash,
          expiresAt,
          createdAt: now,
          memberGuestId: sql`(SELECT ${sessions.memberGuestId} FROM ${sessions} WHERE ${sessions.token} = ${oldHash} AND ${sessions.familyId} = ${familyId})`,
        }),
        db.delete(sessions).where(eq(sessions.token, oldHash)),
      ];

      yield* Effect.tryPromise({
        try: () => commitBatch(db, statements),
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

  /**
   * Set (or, with `null`, clear) the member the session behind `token` says it
   * is. The caller has checked the member belongs to the session's household
   * and is not a plus-one. Scoped to `familyId` as well as the token, so a
   * session can only ever name a member of its own household.
   */
  setMember(
    token: string,
    familyId: string,
    memberGuestId: string | null,
  ): Effect.Effect<void, SessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const tokenHash = yield* hashToken(token);
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .update(sessions)
              .set({ memberGuestId })
              .where(and(eq(sessions.token, tokenHash), eq(sessions.familyId, familyId)))
              .run(),
          ),
        catch: (e) => new SessionWriteError({ op: "setMember", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("session member write failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("cire.session.setMember"));
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

  /**
   * Prune every session whose `expiresAt` has passed (`<= now`). A guest login
   * leaves a row that is dead the moment its 30-day window lapses but is never
   * deleted on the read path (`validate` only *reports* expiry); without this
   * the table grows unbounded. Run from the Worker's `scheduled`
   * cron handler. Boundary is inclusive so a row expiring exactly at `now` is
   * swept. Returns the number of rows deleted.
   */
  sweepExpired(now: Date = new Date()): Effect.Effect<number, SessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const result = yield* Effect.tryPromise({
        try: () => Promise.resolve(db.delete(sessions).where(lte(sessions.expiresAt, now)).run()),
        catch: (e) => new SessionWriteError({ op: "sweep", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("session sweep failed", { reason: err.reason })),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricSessionSwept("ok", deleted));
      yield* Effect.logInfo("session sweep complete", { deleted });
      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricSessionSwept("error"))),
      Effect.withSpan("cire.session.sweepExpired"),
    );
  },
};
