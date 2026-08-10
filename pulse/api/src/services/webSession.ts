import { pulseWebSessions } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { generateToken, hashToken } from "@shared/crypto/tokens";
import { rowsChanged } from "@shared/db-utils";
import type { OsnIdentity } from "@shared/osn-auth-client/oidc-rp";
import { eq, lte } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricWebSessionCreated, metricWebSessionSwept } from "../metrics";

export class WebSessionInvalid extends Data.TaggedError("WebSessionInvalid")<{
  reason: "missing" | "expired";
}> {}

export class WebSessionWriteError extends Data.TaggedError("WebSessionWriteError")<{
  op: "insert" | "delete" | "deleteAllForProfile" | "sweep";
  reason: string;
}> {}

/**
 * Seven days, matching cire's organiser session.
 *
 * Renewal costs the user nothing: while their OSN session is alive — thirty
 * days — the OIDC redirect round-trips without a prompt, so a lapsed Pulse
 * session is an invisible flicker, not a passkey ceremony. Short window, free
 * renewal.
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Login-time snapshot of the ID token's profile claims — the same shape the
 * shared relying party hands back, named for this file's own vocabulary.
 */
export type WebIdentity = OsnIdentity;

export interface CreatedWebSession {
  token: string;
  expiresAt: Date;
}

export interface ValidatedWebSession extends WebIdentity {
  expiresAt: Date;
}

export const webSessionService = {
  create(
    identity: WebIdentity,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Effect.Effect<CreatedWebSession, WebSessionWriteError, Db> {
    return Effect.gen(function* () {
      const { db } = yield* Db;
      const token = generateToken();
      const tokenHash = yield* hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(pulseWebSessions).values({
            id: `pws_${crypto.randomUUID()}`,
            token: tokenHash,
            osnProfileId: identity.osnProfileId,
            osnSub: identity.osnSub,
            email: identity.email,
            handle: identity.handle,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
            expiresAt,
            createdAt: now,
          }),
        catch: (e) => new WebSessionWriteError({ op: "insert", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("web session insert failed", { reason: err.reason }),
        ),
      );
      yield* Effect.sync(() => metricWebSessionCreated("ok"));
      return { token, expiresAt };
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricWebSessionCreated("error"))),
      Effect.withSpan("pulse.webSession.create"),
    );
  },

  /**
   * Resolve a cookie value to its identity. A database read cannot mint a
   * session — only the SHA-256 hash is stored, so the lookup hashes first.
   *
   * Expiry is reported, not deleted: `sweepExpired` owns removal, and a read
   * path that wrote would turn every unauthenticated GET into a write.
   */
  validate(token: string): Effect.Effect<ValidatedWebSession, WebSessionInvalid, Db> {
    return Effect.gen(function* () {
      const { db } = yield* Db;
      if (!token) {
        return yield* Effect.fail(new WebSessionInvalid({ reason: "missing" }));
      }
      const tokenHash = yield* hashToken(token);
      const rows = yield* Effect.tryPromise({
        try: () =>
          db.select().from(pulseWebSessions).where(eq(pulseWebSessions.token, tokenHash)).limit(1),
        // A failed read is indistinguishable from no row to the caller: both
        // mean "not signed in". Nothing here is worth a 500.
        catch: () => new WebSessionInvalid({ reason: "missing" }),
      });
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new WebSessionInvalid({ reason: "missing" }));
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return yield* Effect.fail(new WebSessionInvalid({ reason: "expired" }));
      }
      return {
        osnProfileId: row.osnProfileId,
        osnSub: row.osnSub,
        email: row.email,
        handle: row.handle,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        expiresAt: row.expiresAt,
      };
    }).pipe(Effect.withSpan("pulse.webSession.validate"));
  },

  revoke(token: string): Effect.Effect<void, WebSessionWriteError, Db> {
    return Effect.gen(function* () {
      const { db } = yield* Db;
      const tokenHash = yield* hashToken(token);
      yield* Effect.tryPromise({
        try: () => db.delete(pulseWebSessions).where(eq(pulseWebSessions.token, tokenHash)),
        catch: (e) => new WebSessionWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("web session delete failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("pulse.webSession.revoke"));
  },

  /**
   * Sign out everywhere for one OSN profile. Called on `?all=1` sign-out, and
   * the hook an OSN-side account deletion or OIDC connection revocation should
   * reach for: this is the only browser credential Pulse holds.
   */
  revokeAllForProfile(osnProfileId: string): Effect.Effect<void, WebSessionWriteError, Db> {
    return Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db.delete(pulseWebSessions).where(eq(pulseWebSessions.osnProfileId, osnProfileId)),
        catch: (e) => new WebSessionWriteError({ op: "deleteAllForProfile", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("web session deleteAllForProfile failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("pulse.webSession.revokeAllForProfile"));
  },

  /**
   * Prune every session past its expiry (`<= now`). `validate` only *reports*
   * expiry, so without this the table grows without bound. Returns the number
   * of rows deleted.
   */
  sweepExpired(now: Date = new Date()): Effect.Effect<number, WebSessionWriteError, Db> {
    return Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.delete(pulseWebSessions).where(lte(pulseWebSessions.expiresAt, now)),
        catch: (e) => new WebSessionWriteError({ op: "sweep", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("web session sweep failed", { reason: err.reason }),
        ),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricWebSessionSwept("ok", deleted));
      yield* Effect.logInfo("web session sweep complete", { deleted });
      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricWebSessionSwept("error"))),
      Effect.withSpan("pulse.webSession.sweepExpired"),
    );
  },
};
