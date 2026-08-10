import { organiserSessions } from "@cire/db";
import { generateToken, hashToken } from "@shared/crypto/tokens";
import { rowsChanged } from "@shared/db-utils";
import type { OsnIdentity } from "@shared/osn-auth-client/oidc-rp";
import { eq, lte } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricOrganiserSessionCreated, metricOrganiserSessionSwept } from "../metrics";

export class OrganiserSessionInvalid extends Data.TaggedError("OrganiserSessionInvalid")<{
  reason: "missing" | "expired";
}> {}

export class OrganiserSessionWriteError extends Data.TaggedError("OrganiserSessionWriteError")<{
  op: "insert" | "delete" | "deleteAllForProfile" | "sweep";
  reason: string;
}> {}

/**
 * Seven days, against the guest session's thirty.
 *
 * An organiser session carries far more authority than a guest one (it can
 * rewrite a whole wedding), and renewing it costs the user nothing: while their
 * OSN session is alive — thirty days — the OIDC redirect round-trips without a
 * single prompt, so a lapsed cire session is an invisible flicker, not a
 * passkey ceremony. Short window, free renewal.
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Login-time snapshot of the ID token's profile claims — the same shape the
 * shared relying party hands back, named for this file's own vocabulary.
 */
export type OrganiserIdentity = OsnIdentity;

export interface CreatedOrganiserSession {
  token: string;
  expiresAt: Date;
}

export interface ValidatedOrganiserSession extends OrganiserIdentity {
  expiresAt: Date;
}

export const organiserSessionService = {
  create(
    identity: OrganiserIdentity,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Effect.Effect<CreatedOrganiserSession, OrganiserSessionWriteError, DbService> {
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
              .insert(organiserSessions)
              .values({
                id: `oss_${crypto.randomUUID()}`,
                token: tokenHash,
                osnProfileId: identity.osnProfileId,
                osnSub: identity.osnSub,
                email: identity.email,
                handle: identity.handle,
                displayName: identity.displayName,
                avatarUrl: identity.avatarUrl,
                expiresAt,
                createdAt: now,
              })
              .run(),
          ),
        catch: (e) => new OrganiserSessionWriteError({ op: "insert", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("organiser session insert failed", { reason: err.reason }),
        ),
      );
      yield* Effect.sync(() => metricOrganiserSessionCreated("ok"));
      return { token, expiresAt };
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricOrganiserSessionCreated("error"))),
      Effect.withSpan("cire.organiserSession.create"),
    );
  },

  validate(
    token: string,
  ): Effect.Effect<ValidatedOrganiserSession, OrganiserSessionInvalid, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (!token) {
        return yield* Effect.fail(new OrganiserSessionInvalid({ reason: "missing" }));
      }
      const tokenHash = yield* hashToken(token);
      const [row] = yield* dbQuery(() =>
        db.select().from(organiserSessions).where(eq(organiserSessions.token, tokenHash)).all(),
      );
      if (!row) {
        return yield* Effect.fail(new OrganiserSessionInvalid({ reason: "missing" }));
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return yield* Effect.fail(new OrganiserSessionInvalid({ reason: "expired" }));
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
    }).pipe(Effect.withSpan("cire.organiserSession.validate"));
  },

  revoke(token: string): Effect.Effect<void, OrganiserSessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const tokenHash = yield* hashToken(token);
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db.delete(organiserSessions).where(eq(organiserSessions.token, tokenHash)).run(),
          ),
        catch: (e) => new OrganiserSessionWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("organiser session delete failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("cire.organiserSession.revoke"));
  },

  /**
   * Sign out everywhere for one OSN profile. Called on `?all=1` sign-out, and
   * the hook an OSN-side account deletion should reach for: cire holds no other
   * live credential for an organiser.
   */
  revokeAllForProfile(
    osnProfileId: string,
  ): Effect.Effect<void, OrganiserSessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(organiserSessions)
              .where(eq(organiserSessions.osnProfileId, osnProfileId))
              .run(),
          ),
        catch: (e) =>
          new OrganiserSessionWriteError({ op: "deleteAllForProfile", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("organiser session deleteAllForProfile failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("cire.organiserSession.revokeAllForProfile"));
  },

  /**
   * Prune every session past its expiry (`<= now`). `validate` only *reports*
   * expiry, so without this the table grows without bound — the same C-M2/C-M15
   * reasoning as the guest sweep. Run from the Worker's `scheduled` cron.
   * Returns the number of rows deleted.
   */
  sweepExpired(
    now: Date = new Date(),
  ): Effect.Effect<number, OrganiserSessionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db.delete(organiserSessions).where(lte(organiserSessions.expiresAt, now)).run(),
          ),
        catch: (e) => new OrganiserSessionWriteError({ op: "sweep", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("organiser session sweep failed", { reason: err.reason }),
        ),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricOrganiserSessionSwept("ok", deleted));
      yield* Effect.logInfo("organiser session sweep complete", { deleted });
      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricOrganiserSessionSwept("error"))),
      Effect.withSpan("cire.organiserSession.sweepExpired"),
    );
  },
};
