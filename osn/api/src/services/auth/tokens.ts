/**
 * Token issuance, server-side session refresh + rotation (Copenhagen Book
 * C1), rotated-token reuse detection (C2), and access-token verification.
 */

import { accounts, rotatedSessions, sessions, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch, rowsChanged } from "@shared/db-utils";
import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { Clock, Effect } from "effect";

import { canBatch } from "../../lib/batch";
import { bound } from "../../lib/bound";
import { ROTATION_RACE_MESSAGE } from "../../lib/grant-failure";
import {
  metricRetentionSweep,
  metricSessionFamilyRevoked,
  metricSessionReuseDetected,
  metricSessionRotationRace,
  withAuthTokenRefresh,
  withSessionRotation,
} from "../../metrics";
import {
  ACCESS_TOKEN_AUDIENCE,
  LAST_USED_AT_COALESCE_MS,
  MAX_SESSIONS_PER_ACCOUNT,
  RECOVERY_SESSION_TTL_SEC,
  RECOVERY_TOKEN_AUDIENCE,
  ROTATED_SESSION_SWEEP_CHUNK,
  ROTATED_SESSION_SWEEP_MAX_CHUNKS,
  ROTATED_SESSION_SWEEP_PAUSE_MS,
  ROTATION_GRACE_MS,
} from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import {
  deriveSessionBinding,
  generateSessionToken,
  genId,
  hashSessionToken,
  signJwt,
  verifyJwt,
} from "./helpers";
import type { AccessTokenClaims } from "./helpers";
import { selectProfileById, type ProfilesModule } from "./profiles";
import { inLiveFamilyOf } from "./sessions";
import type { ProfileWithEmail, RecoveryFactorAmr, SessionMeta, TokenSet } from "./types";

/** The most chunks a tier may ask one sweep pass for. */
export const ROTATED_SESSION_SWEEP_MAX_CHUNKS_CEILING = 200;

/**
 * The tier's per-pass chunk cap, from `OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS`
 * (`osn/api/wrangler.toml` sets it for staging and production; the Worker's
 * `scheduled` handler reads it). Unset: {@link ROTATED_SESSION_SWEEP_MAX_CHUNKS},
 * which keeps a Workers Free tier inside its 50 D1 queries per invocation,
 * shared by the four sweeps of one cron tick. A whole number from 1 to
 * {@link ROTATED_SESSION_SWEEP_MAX_CHUNKS_CEILING}: that number, which keeps a
 * Workers Paid tier well inside its 1,000. Anything else is `"invalid"`, for
 * the caller to log and replace with the default.
 */
export function rotatedSweepMaxChunks(raw: string | undefined): number | "invalid" {
  if (raw === undefined || raw === "") return ROTATED_SESSION_SWEEP_MAX_CHUNKS;
  if (!/^[0-9]+$/.test(raw)) return "invalid";
  const chunks = Number(raw);
  return chunks >= 1 && chunks <= ROTATED_SESSION_SWEEP_MAX_CHUNKS_CEILING ? chunks : "invalid";
}

/**
 * Deletes expired `rotated_sessions` rows, in chunks of
 * {@link ROTATED_SESSION_SWEEP_CHUNK} and at most `maxChunks` of them (the
 * tier's cap, {@link rotatedSweepMaxChunks}), so one run's writes and
 * statements stay bounded however far behind the table is. A pass that ends
 * on a full chunk has left expired rows behind, and says so in a warning, so
 * a backlog shows in the Worker's logs. A row is expired once
 * `expires_at <= now`: past that, reuse detection ignores it.
 *
 * Each chunk is `DELETE … WHERE rowid IN (SELECT rowid … LIMIT n)`: the
 * subquery binds the same few values whatever the chunk size, never one per
 * row, and its `expires_at` range can use `rotated_sessions_expires_idx`.
 * Between two chunks it waits {@link ROTATED_SESSION_SWEEP_PAUSE_MS}, so
 * requests waiting to write run in between; it never waits after the last.
 * Each pass, failed or not, adds the rows it deleted to
 * `osn.retention.rows_deleted` and its time to `osn.retention.cycle.duration`,
 * both under `table: "rotated_sessions"` (the sweeper design contract in
 * `wiki/compliance/retention.md`).
 *
 * Standalone so the Workers `scheduled` handler and the Bun sweeper can run it
 * beside the account-deletion sweeps.
 */
export const runRotatedSessionSweep = (
  opts: { nowMs?: number; maxChunks?: number } = {},
): Effect.Effect<{ deleted: number }, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const nowMs = opts.nowMs ?? Date.now();
    const maxChunks = opts.maxChunks ?? ROTATED_SESSION_SWEEP_MAX_CHUNKS;
    const startedAt = yield* Clock.currentTimeMillis;
    let deleted = 0;
    const deleteChunk = Effect.tryPromise({
      try: () =>
        db.delete(rotatedSessions).where(
          inArray(
            sql`rowid`,
            db
              .select({ rowid: sql<number>`rowid` })
              .from(rotatedSessions)
              .where(lte(rotatedSessions.expiresAt, nowMs))
              .limit(ROTATED_SESSION_SWEEP_CHUNK),
          ),
        ),
      catch: (cause) => new DatabaseError({ cause }),
    });
    yield* Effect.gen(function* () {
      for (let chunk = 0; chunk < maxChunks; chunk++) {
        if (chunk > 0) yield* Effect.sleep(ROTATED_SESSION_SWEEP_PAUSE_MS);
        const changed = rowsChanged(yield* deleteChunk);
        deleted += changed;
        if (changed < ROTATED_SESSION_SWEEP_CHUNK) return;
      }
      // Every chunk came back full, so expired rows are likely still there.
      yield* Effect.logWarning("auth.session.rotated_sweep ended on a full chunk").pipe(
        Effect.annotateLogs({ chunks: maxChunks, deleted }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeMillis;
          metricRetentionSweep("rotated_sessions", deleted, (endedAt - startedAt) / 1000);
        }),
      ),
    );
    return { deleted };
  }).pipe(Effect.withSpan("auth.session.rotated_sweep"));

export function createTokensModule(ctx: AuthContext, profiles: ProfilesModule) {
  const { config, accessTokenTtl, refreshTokenTtl, hashIp, passkeyRegisterAllowedAmr } = ctx;
  const { findDefaultProfile } = profiles;

  // -------------------------------------------------------------------------
  // Token issuance
  // -------------------------------------------------------------------------

  /**
   * Signs a short-lived ES256 access token JWT. Used by both initial login
   * (via `issueTokens`) and token refresh / profile switch (standalone).
   *
   * `audience` decides what the token can reach. It defaults to
   * {@link ACCESS_TOKEN_AUDIENCE}; the only other value it is ever given is
   * {@link RECOVERY_TOKEN_AUDIENCE}, for a restricted recovery session.
   *
   * `ttlSec` shortens the configured lifetime — see {@link sessionBoundTtl},
   * which is the only thing that ever passes it.
   */
  const issueAccessToken = (
    profileId: string,
    email: string,
    handle: string,
    displayName: string | null,
    sessionBinding?: string | null,
    audience: string = ACCESS_TOKEN_AUDIENCE,
    ttlSec: number = accessTokenTtl,
  ) =>
    Effect.tryPromise({
      try: () => {
        // `accountId` is never in the access-token payload. Including it
        // would let any external observer (a downstream service, a JWT
        // decoder in the browser, a leaked log line) correlate two profiles
        // as belonging to the same account; see wiki/osn/identity-model.md.
        // A service that needs the account behind a step-up gets it
        // server-to-server instead: `/internal/step-up/verify` returns the
        // verified accountId to the calling service over an ARC-authenticated
        // channel.
        const payload: AccessTokenClaims = {
          sub: profileId,
          aud: audience,
          email,
          handle,
          scope: "openid profile",
        };
        if (displayName !== null) payload["displayName"] = displayName;
        // The session binding. One-way, per-profile (see
        // `deriveSessionBinding`) — lets a Bearer-only caller be matched to
        // its own session row without a cookie and without leaking either
        // the session id or the account behind the profile.
        if (sessionBinding) payload["osn_sid"] = sessionBinding;
        return signJwt(payload, config.jwtPrivateKey, config.jwtKid, ttlSec, config.issuerUrl);
      },
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  /**
   * The access-token lifetime a session of this kind may hand out.
   *
   * For an ordinary session (`restrictedUntil === null`) that is the configured
   * `accessTokenTtl` and nothing else. For a **restricted recovery session** it
   * is whatever is smaller: the configured lifetime, or the time the session row
   * itself has left. A restricted row's deadline is absolute — rotation copies
   * it forward rather than extending it — so without this cap the last token of
   * the window outlives the row that authorises it, and the browser is told a
   * later deadline than the one the server will honour. The screen holding it
   * then shows a live button that every request refuses.
   *
   * The floor of 1 covers the sub-second case where this clock read lands a
   * second after the one `verifyRefreshToken` admitted the row on.
   *
   * This bounds the token, not the session: `verifyJwt` allows 30 s of clock
   * skew, so a capped token still verifies for a little after its row is gone.
   * Nothing is granted in that window — the enrolment bypass tests the row's own
   * deadline (`recoverySessionAdmitsEnrolment`), never the token's.
   */
  const sessionBoundTtl = (restrictedUntil: number | null, nowSec: number): number =>
    restrictedUntil === null
      ? accessTokenTtl
      : Math.max(1, Math.min(accessTokenTtl, restrictedUntil - nowSec));

  /**
   * At the cap, deletes the least recently used `sessions` rows on
   * `accountId`, leaving one fewer than MAX_SESSIONS_PER_ACCOUNT of them. Rows
   * in `exceptFamilyId`, when it is not null, are neither counted nor deleted.
   */
  const evictLeastRecentlyUsed = (
    accountId: string,
    exceptFamilyId: string | null,
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ id: sessions.id, lastUsedAt: sessions.lastUsedAt })
            .from(sessions)
            .where(
              exceptFamilyId === null
                ? eq(sessions.accountId, accountId)
                : and(eq(sessions.accountId, accountId), ne(sessions.familyId, exceptFamilyId)),
            )
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT + 1);
          if (rows.length >= MAX_SESSIONS_PER_ACCOUNT) {
            const evictIds = rows.slice(MAX_SESSIONS_PER_ACCOUNT - 1).map((r) => r.id);
            // oxlint-disable-next-line house/no-unbounded-in-array -- at most two ids: the tail of a MAX_SESSIONS_PER_ACCOUNT + 1 read
            await db.delete(sessions).where(inArray(sessions.id, evictIds));
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  /**
   * Makes room for one more `sessions` row on `accountId`. At the cap it
   * deletes the least recently used rows, leaving one fewer than
   * MAX_SESSIONS_PER_ACCOUNT, so the insert that follows leaves the account
   * at the cap. Every new session — `issueTokens` and a restricted recovery
   * session — calls it first; rotation inserts a row only in place of the one
   * it then deletes, and a
   * reservation makes room only once it is to stand
   * ({@link makeRoomForReservation}).
   *
   * A stolen credential can never hold more than the cap's worth of sessions
   * open, and an account with many devices loses its least recently used
   * session instead of failing the new sign-in.
   */
  const makeRoomForSession = (accountId: string): Effect.Effect<void, DatabaseError, Db> =>
    evictLeastRecentlyUsed(accountId, null);

  /**
   * Inserts a `sessions` row for `accountId` in family `familyId`, live until
   * `expiresAtSec`, whose token nobody holds: the token it hashes is dropped
   * here, so the row can never be presented. It holds a place that any
   * revocation removes, and answers the row's id. It counts against the
   * session cap like any other row, but evicts nothing: until the caller runs
   * {@link makeRoomForReservation}, the account holds one row over the cap
   * for each reservation in flight.
   */
  const reserveSession = (
    accountId: string,
    familyId: string,
    expiresAtSec: number,
    sessionMeta: SessionMeta | undefined,
  ): Effect.Effect<string, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const id = hashSessionToken(generateSessionToken());
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(sessions).values({
            id,
            accountId,
            familyId,
            expiresAt: expiresAtSec,
            createdAt: nowSec,
            authenticatedAt: nowSec,
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
            lastUsedAt: nowSec,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return id;
    });

  /**
   * Brings an account holding a reservation in `familyId` back to the cap,
   * once that reservation is to stand. At the cap it deletes the least
   * recently used rows outside the family, leaving one fewer than
   * MAX_SESSIONS_PER_ACCOUNT of them, so with the one reservation the account
   * holds the cap. The family's other reservations are left out of the count:
   * each is released by the call that made it, and counting one would evict a
   * session for a row about to go.
   */
  const makeRoomForReservation = (
    accountId: string,
    familyId: string,
  ): Effect.Effect<void, DatabaseError, Db> => evictLeastRecentlyUsed(accountId, familyId);

  /**
   * Turns the reserved row `reservedId` into a live session for the profile
   * `profileId` and mints its tokens: the cross-device poll's last step, once
   * it has taken the approval.
   *
   * One batch, which D1 runs as one transaction and one round trip: the
   * profile read; an UPDATE that gives the row a fresh token's id, a family of
   * its own and a session's life, only while the row is live, its account is
   * not deleted or scheduled for deletion, and the profile is still in that
   * account; and a DELETE that removes the reservation when that UPDATE did
   * not take it. Answers null when it did not take it: a revocation removed
   * the row, it expired, or the account or profile no longer stands.
   *
   * Evicts nothing. The UPDATE changes no row count, so the account stays
   * where the approval's {@link makeRoomForReservation} left it, and another
   * request's reservation is never counted against this sign-in.
   */
  const claimReservation = (
    accountId: string,
    reservedId: string,
    profileId: string,
  ): Effect.Effect<
    { session: TokenSet; profile: ProfileWithEmail } | null,
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const sessionToken = generateSessionToken();
      const sessionId = hashSessionToken(sessionToken);
      const nowSec = Math.floor(Date.now() / 1000);
      const profileRead = selectProfileById(db, profileId);
      const claim = db
        .update(sessions)
        .set({
          id: sessionId,
          familyId: genId("sfam_"),
          expiresAt: nowSec + refreshTokenTtl,
          createdAt: nowSec,
          authenticatedAt: nowSec,
          lastUsedAt: nowSec,
        })
        .where(
          and(
            eq(sessions.id, reservedId),
            eq(sessions.accountId, accountId),
            gt(sessions.expiresAt, nowSec),
            exists(
              db
                .select({ one: sql`1` })
                .from(users)
                .innerJoin(accounts, eq(accounts.id, users.accountId))
                .where(
                  and(
                    eq(users.id, profileId),
                    eq(users.accountId, accountId),
                    isNull(accounts.deletedAt),
                  ),
                ),
            ),
          ),
        );
      const release = db
        .delete(sessions)
        .where(and(eq(sessions.id, reservedId), eq(sessions.accountId, accountId)));
      const [profileRows, claimed] = yield* Effect.tryPromise({
        try: async () =>
          canBatch(db)
            ? await db.batch([profileRead, claim, release])
            : ([await profileRead, await claim, await release] as const),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const profile = profileRows[0];
      if (rowsChanged(claimed) !== 1 || !profile || profile.accountId !== accountId) return null;

      const accessToken = yield* issueAccessToken(
        profile.id,
        profile.email,
        profile.handle,
        profile.displayName,
        deriveSessionBinding(sessionId, profile.id),
      );
      return {
        session: { accessToken, refreshToken: sessionToken, expiresIn: accessTokenTtl },
        profile,
      };
    });

  /**
   * Full token issuance: creates a server-side session row and returns an
   * opaque session token (the "refresh token") alongside a short-lived
   * access token JWT. The session token is what the client persists; the
   * server only stores its SHA-256 hash (Copenhagen Book C1).
   *
   * `familyId` groups all rotated tokens in a single refresh chain.
   * On initial login it is generated fresh; on rotation it is propagated
   * from the previous session so reuse detection can revoke the entire family.
   */
  const issueSession = (
    profileId: string,
    accountId: string,
    email: string,
    handle: string,
    displayName: string | null,
    familyId: string | undefined,
    sessionMeta: SessionMeta | undefined,
    /**
     * The factor behind a restricted recovery session, or `null` for an
     * ordinary one. Non-null is what makes the session restricted, and the
     * value is stored: the enrolment bypass reads it back rather than trusting
     * the token's audience alone.
     */
    restrictedAmr: RecoveryFactorAmr | null,
  ): Effect.Effect<TokenSet, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const restricted = restrictedAmr !== null;
      // Generate opaque session token + store SHA-256 hash in DB. This runs
      // BEFORE the access token is signed: the JWT carries a binding to the
      // session it was minted from (`osn_sid`).
      const sessionToken = generateSessionToken();
      const sessionId = hashSessionToken(sessionToken);
      // One clock read, taken before the mint so the token's lifetime and the
      // row's deadline are computed against the same instant. Every field below
      // (`createdAt`, `authenticatedAt`, `lastUsedAt`, `expiresAt`) reads it
      // too, so they move together.
      const nowSec = Math.floor(Date.now() / 1000);
      // A restricted session's deadline is absolute: the row's `expiresAt` IS
      // its `restrictedUntil`, and neither the sliding window in
      // `verifyRefreshToken` nor rotation in `refreshTokens` moves it.
      const restrictedUntil = restricted ? nowSec + RECOVERY_SESSION_TTL_SEC : null;
      const accessToken = yield* issueAccessToken(
        profileId,
        email,
        handle,
        displayName,
        deriveSessionBinding(sessionId, profileId),
        restricted ? RECOVERY_TOKEN_AUDIENCE : ACCESS_TOKEN_AUDIENCE,
        sessionBoundTtl(restrictedUntil, nowSec),
      );
      const fam = familyId ?? genId("sfam_");

      yield* makeRoomForSession(accountId);
      const { db } = yield* Db;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(sessions).values({
            id: sessionId,
            accountId,
            familyId: fam,
            expiresAt: restrictedUntil ?? nowSec + refreshTokenTtl,
            createdAt: nowSec,
            // First authentication on this device. Copied forward on every
            // rotation so `auth_time`/`max_age` stay honest across silent refresh.
            authenticatedAt: nowSec,
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
            lastUsedAt: nowSec,
            restrictedUntil,
            restrictedAmr,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return {
        accessToken,
        refreshToken: sessionToken,
        expiresIn: sessionBoundTtl(restrictedUntil, nowSec),
      };
    });

  /** Ordinary, unrestricted session issuance. See {@link issueSession}. */
  const issueTokens = (
    profileId: string,
    accountId: string,
    email: string,
    handle: string,
    displayName: string | null,
    familyId?: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<TokenSet, AuthError | DatabaseError, Db> =>
    issueSession(profileId, accountId, email, handle, displayName, familyId, sessionMeta, null);

  /**
   * Issues a **restricted recovery session**: the session account recovery
   * hands out once an email OTP or a TOTP code has proved the user is who they
   * say. Its access token carries {@link RECOVERY_TOKEN_AUDIENCE}, so it is
   * rejected by every verifier in this service and in the three downstream
   * services except `resolvePasskeyEnrollPrincipal`. Enrolling a passkey is the
   * only thing it can do, and doing so lifts the restriction.
   *
   * Always a fresh family: a recovery session is a new chain, never a
   * continuation of whatever the user held before.
   *
   * `amr` names the factor that proved the user's identity, and it is
   * **required**. Enrolling past the step-up gate is the one privilege this
   * session has, and it is granted on the strength of that ceremony — so the
   * factor is refused here when `passkeyRegisterAllowedAmr` does not admit it,
   * and recorded on the session row so the gate can check it rather than infer
   * it from the audience. A caller cannot mint a session whose factor the
   * enrolment gate would not have accepted.
   *
   * The caller must set the session cookie exactly as `/login/recovery/complete`
   * does. `completePasskeyRegistration`'s other-session sweep resolves the
   * caller from that cookie (or from the token's `osn_sid`), and answers
   * `session_stale` when it can resolve neither.
   */
  const issueRecoverySession = (
    profileId: string,
    accountId: string,
    email: string,
    handle: string,
    displayName: string | null,
    amr: RecoveryFactorAmr,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<TokenSet, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      if (!passkeyRegisterAllowedAmr.has(amr)) {
        // Same shape as any other refusal on this surface: the caller asked for
        // a session it may not have, and no session is issued.
        return yield* Effect.fail(
          new AuthError({ message: "Recovery factor not permitted for passkey enrolment" }),
        );
      }
      return yield* issueSession(
        profileId,
        accountId,
        email,
        handle,
        displayName,
        undefined,
        sessionMeta,
        amr,
      );
    });

  // -------------------------------------------------------------------------
  // Token refresh (server-side sessions — Copenhagen Book C1)
  // -------------------------------------------------------------------------

  /**
   * Verifies a session token by looking up its SHA-256 hash in the sessions
   * table. Implements sliding-window expiry: when less than half the TTL
   * remains, `expiresAt` is extended by the full TTL from now.
   *
   * Returns the session's `accountId`, `familyId` and `sessionId` (the hash),
   * its authentication time and its restriction, all from the one row read
   * here. `refreshTokens` rotates from the account, family, hash and
   * restriction; it copies the device onto the new session from the old row
   * as it stands when the insert runs, not from this read.
   *
   * Two callers: `refreshTokens` here, and the OIDC provider's `resolveSession`
   * (`routes/auth/oidc.ts`), which is how `/authorize` learns whether this
   * browser is signed in.
   *
   * **A restricted recovery session is rejected unless `allowRestricted` is
   * set.** That default is the point: this function answers "is this cookie a
   * live session", and a restricted session is not one for any purpose except
   * rotating itself. Without the default, a recovery cookie would complete an
   * OIDC authorization and sign the user into every relying party — laundering
   * a restricted session into full access at a different service, which is
   * exactly what the audience exists to prevent. `refreshTokens` is the only
   * caller that opts in.
   */
  const verifyRefreshToken = (
    token: string,
    options?: { readonly allowRestricted?: boolean },
  ): Effect.Effect<
    {
      accountId: string;
      familyId: string;
      sessionId: string;
      authenticatedAt: number;
      restrictedUntil: number | null;
      restrictedAmr: string | null;
    },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const sessionId = hashSessionToken(token);
      const { db } = yield* Db;

      const result = yield* Effect.tryPromise({
        try: () => db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const session = result[0];

      if (!session) {
        // Reuse detection (C2): the token was not found — it may have been
        // rotated out. If so, revoke the entire session family.
        yield* detectReuse(sessionId);
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired session" }));
      }

      const nowSec = Math.floor(Date.now() / 1000);

      // Expired — clean up lazily. Only while it is still expired: a verify
      // of the same token a moment earlier may have found it live and
      // extended it (below) since this one read it, and that session stays.
      if (nowSec >= session.expiresAt) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .delete(sessions)
              .where(and(eq(sessions.id, sessionId), lte(sessions.expiresAt, nowSec))),
          catch: (cause) => new DatabaseError({ cause }),
        });
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired session" }));
      }

      // A restricted recovery session is not a session for anything but its
      // own rotation. Same error as an expired or unknown token, so a caller
      // cannot tell "restricted" from "gone".
      if (session.restrictedUntil !== null && !options?.allowRestricted) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired session" }));
      }

      // Sliding window: extend when less than half the TTL remains.
      // `last_used_at` is coalesced (`LAST_USED_AT_COALESCE_MS`) — writing it
      // on every verify would add a DB round-trip per refresh. The Sessions
      // UI doesn't need sub-second accuracy; 60 s granularity shrinks writes
      // by roughly the refresh cadence.
      //
      // A restricted session never slides, and the guard has to be explicit:
      // its whole 15-minute life is far inside half of a 30-day TTL, so the
      // comparison alone is ALWAYS true and would extend the one session that
      // must expire on schedule. `last_used_at` is still touched — it is what
      // `liveSessionIds` orders by, and the enrolment sweep resolves the
      // caller's own session through that list.
      const halfTtl = Math.floor(refreshTokenTtl / 2);
      const shouldExtend = session.restrictedUntil === null && session.expiresAt - nowSec < halfTtl;
      const lastUsedMs = (session.lastUsedAt ?? session.createdAt) * 1000;
      const shouldTouchLastUsed = Date.now() - lastUsedMs >= LAST_USED_AT_COALESCE_MS;

      if (shouldExtend || shouldTouchLastUsed) {
        const updates: Record<string, number> = {};
        if (shouldExtend) updates["expiresAt"] = nowSec + refreshTokenTtl;
        if (shouldTouchLastUsed) updates["lastUsedAt"] = nowSec;
        yield* Effect.tryPromise({
          try: () => db.update(sessions).set(updates).where(eq(sessions.id, sessionId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
      }

      // `authenticatedAt` is the moment the user actually authenticated on this
      // device, copied forward across every rotation (falling back to
      // `createdAt` for a row written before the column). It is the honest
      // `auth_time` for the OIDC provider: a 29-day-old passkey ceremony reads
      // as 29 days old even after dozens of silent refreshes, so a relying
      // party's `max_age` reflects real user presence, not the last background
      // refresh.
      return {
        accountId: session.accountId,
        familyId: session.familyId,
        sessionId,
        authenticatedAt: session.authenticatedAt ?? session.createdAt,
        restrictedUntil: session.restrictedUntil,
        restrictedAmr: session.restrictedAmr,
      };
    });

  // -------------------------------------------------------------------------
  // Reuse detection (Copenhagen Book C2)
  //
  // When a session hash is not found in the DB, it may have been rotated
  // out by a prior refresh. `refreshTokens` records every rotated-out hash
  // in `rotated_sessions`, in the same batch as the session that replaces
  // it, so a replayed old token finds its record and revokes the family.
  // -------------------------------------------------------------------------

  /** How long a rotation record proves reuse: the life of the token it records. */
  const rotatedRecordTtlMs = refreshTokenTtl * 1000;

  /**
   * Checks if a missing session hash was recently rotated. If so, revokes
   * the entire family — both the legitimate holder and the attacker are
   * logged out, which is the correct security response per the Copenhagen
   * Book.
   *
   * Fails closed: a failed read is a `DatabaseError`, so the grant fails and
   * nothing is revoked. A storage error never passes for "not rotated", and
   * never manufactures a revocation either.
   */
  const detectReuse = (sessionHash: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowMs = Date.now();
      const [record] = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              accountId: rotatedSessions.accountId,
              familyId: rotatedSessions.familyId,
              rotatedAt: rotatedSessions.rotatedAt,
            })
            .from(rotatedSessions)
            .where(
              and(eq(rotatedSessions.tokenHash, sessionHash), gt(rotatedSessions.expiresAt, nowMs)),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (!record) return;

      // Grace window: a rotated-out hash replayed within ROTATION_GRACE_MS of
      // its rotation is benign concurrency — a legitimate client fired two
      // near-simultaneous grants of the same token (multi-tab reload, a
      // bootstrap racing a 401-refresh) or retried after a lost response. The
      // winning grant already rotated the family forward; this replay just
      // loses. Treat it as a race, NOT reuse — preserve the family so the user
      // stays signed in. A replay OUTSIDE the window is genuine reuse below.
      if (nowMs - record.rotatedAt < ROTATION_GRACE_MS) {
        metricSessionRotationRace();
        yield* Effect.logInfo(
          "Rotated-token replay within grace window — benign concurrent refresh, family preserved",
        );
        return;
      }

      // Replayed rotated-out token outside the grace window — revoke the
      // family's sessions and, with them, its rotation records: once the
      // family is gone a further replay from the same chain has nothing left
      // to revoke. The revoke is counted, and warned of, only when it removed
      // a session: a family already revoked (by handle, say) leaves records
      // that a stale replay still finds.
      const { accountId, familyId } = record;
      metricSessionReuseDetected();
      const removeSessions = db.delete(sessions).where(eq(sessions.familyId, familyId));
      // Led by `account_id` so it searches `rotated_sessions_account_family_idx`.
      const removeRecords = db
        .delete(rotatedSessions)
        .where(
          and(eq(rotatedSessions.accountId, accountId), eq(rotatedSessions.familyId, familyId)),
        );
      const removed = yield* Effect.tryPromise({
        // One batch on D1; one statement at a time on bun:sqlite.
        try: async () => {
          const [result] = canBatch(db)
            ? await db.batch([removeSessions, removeRecords])
            : ([await removeSessions, await removeRecords] as const);
          return rowsChanged(result);
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (removed > 0) {
        metricSessionFamilyRevoked();
        yield* Effect.logWarning("Session token reuse detected — family revoked");
      } else {
        yield* Effect.logInfo("Session token reuse detected — no session of the family was left");
      }
    }).pipe(Effect.withSpan("auth.session.reuse_detect"));

  /**
   * Refreshes a session: verifies the session token, finds the default
   * profile, issues a new access token, and **rotates** the session token
   * (Copenhagen Book C2): the new session row is inserted, then the old
   * hash's `rotated_sessions` record, then the old row deleted, so a replayed
   * old token triggers full family revocation (reuse detection). On D1 the
   * three are one batch, which commits whole or not at all; a failed write is
   * a `DatabaseError`, which `POST /token` reads as "session status unknown",
   * and the old session stays. A revoke of the family or the account that
   * lands at any point of a rotation leaves no session behind it.
   */
  const refreshTokens = (
    sessionToken: string,
  ): Effect.Effect<
    { accessToken: string; refreshToken: string; expiresIn: number },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const {
        accountId,
        familyId,
        sessionId: oldSessionId,
        restrictedUntil,
        // The one caller allowed to rotate a restricted session — rotating it
        // is the only thing a restricted session is for.
      } = yield* verifyRefreshToken(sessionToken, { allowRestricted: true });
      const profile = yield* findDefaultProfile(accountId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }

      // Rotate: insert the new session in the same family, then delete the
      // old one. The new session id is minted first so the access token binds
      // to the session the caller will actually hold after this grant, not the
      // one being rotated out.
      const newSessionToken = generateSessionToken();
      const newSessionId = hashSessionToken(newSessionToken);

      // One clock read, taken before the mint so the token's lifetime is
      // measured against the same instant as the row fields below.
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);

      // The restriction rides the SESSION ROW, not the token, so it survives
      // the silent refresh that would otherwise retire it five minutes in.
      // The row's deadline also caps the token: a restricted session does not
      // extend on rotation, so a full-length token here would outlive the row
      // that authorises it and tell the browser a deadline the server will not
      // honour.
      const accessToken = yield* issueAccessToken(
        profile.id,
        profile.email,
        profile.handle,
        profile.displayName,
        deriveSessionBinding(newSessionId, profile.id),
        restrictedUntil === null ? ACCESS_TOKEN_AUDIENCE : RECOVERY_TOKEN_AUDIENCE,
        sessionBoundTtl(restrictedUntil, nowSec),
      );

      const { db } = yield* Db;
      const oldRow = eq(sessions.id, oldSessionId);
      const newRow = eq(sessions.id, newSessionId);

      // 1. The new session, written only while the old one stands. It copies
      //    the device from the old row as that row stands when the insert
      //    runs: the UA label and IP hash, so the device keeps its identity
      //    across rotations, and any restriction, so one lifted since the read
      //    above stays lifted. The access token minted above keeps the read's
      //    audience, which is never wider than the row's.
      const mint = () =>
        db.insert(sessions).select(
          db
            .select({
              id: bound(newSessionId, sessions.id),
              accountId: sessions.accountId,
              familyId: sessions.familyId,
              // A restricted session keeps its original absolute deadline
              // across every rotation: a 30-day life here would outlive the
              // fifteen minutes it must die in, and the client refreshes
              // silently, so it would happen on its own.
              expiresAt: sql<number>`coalesce(${sessions.restrictedUntil}, ${
                nowSec + refreshTokenTtl
              })`.as(sessions.expiresAt.name),
              createdAt: bound(nowSec, sessions.createdAt),
              // The device's original authentication time, so a background
              // refresh cannot reset `auth_time` to now and satisfy a relying
              // party's `max_age` with no user present. A row older than the
              // column falls back to its `created_at`.
              authenticatedAt: sql<number>`coalesce(${sessions.authenticatedAt}, ${
                sessions.createdAt
              })`.as(sessions.authenticatedAt.name),
              uaLabel: sessions.uaLabel,
              ipHash: sessions.ipHash,
              lastUsedAt: bound(nowSec, sessions.lastUsedAt),
              restrictedUntil: sessions.restrictedUntil,
              // Carried with the deadline: the enrolment bypass reads the
              // factor off whichever row the caller currently holds.
              restrictedAmr: sessions.restrictedAmr,
            })
            .from(sessions)
            .where(oldRow),
        );
      // 2. The record of the rotated-out token, only once this request's new
      //    session is in, so reuse detection sees the old token replayed. Its
      //    key is the old token's hash: a second record for it fails the grant
      //    as a storage failure.
      const record = () =>
        db.insert(rotatedSessions).select(
          db
            .select({
              tokenHash: bound(oldSessionId, rotatedSessions.tokenHash),
              familyId: bound(familyId, rotatedSessions.familyId),
              accountId: bound(accountId, rotatedSessions.accountId),
              rotatedAt: bound(nowMs, rotatedSessions.rotatedAt),
              expiresAt: bound(nowMs + rotatedRecordTtlMs, rotatedSessions.expiresAt),
            })
            .from(sessions)
            .where(newRow),
        );
      // 3. The compare-and-swap: the old session goes only while the new one
      //    stands. The grant succeeds only if both rows stood at this moment.
      const swap = () =>
        db.delete(sessions).where(
          and(
            oldRow,
            exists(
              db
                .select({ one: sql`1` })
                .from(sessions)
                .where(newRow),
            ),
          ),
        );

      // At every moment of a rotation the family holds the old row, the new
      // row or both, so a delete of the family or the account that lands at
      // any point removes whatever stands and every later statement here finds
      // nothing. One batch on D1, which commits whole or not at all; one
      // statement at a time on bun:sqlite, each built once the one before has
      // run. Change counts go through `rowsChanged`, which reads D1's
      // `meta.changes`.
      let newRowLeft = false;
      const written = yield* Effect.tryPromise({
        try: async () => {
          if (canBatch(db)) {
            const [, recorded, swapped] = await db.batch([mint(), record(), swap()]);
            return { recorded: rowsChanged(recorded), swapped: rowsChanged(swapped) };
          }
          try {
            await mint();
            const recorded = rowsChanged(await record());
            const swapped = rowsChanged(await swap());
            return { recorded, swapped };
          } catch (error) {
            // The new row is this request's alone; it goes with the failure,
            // and the old row stays, as a failed D1 batch leaves it. A delete
            // that fails too leaves the row, held by no one, until it
            // expires; that is logged below, and the grant fails with the
            // first error either way.
            await db
              .delete(sessions)
              .where(newRow)
              .then(
                () => undefined,
                () => {
                  newRowLeft = true;
                },
              );
            throw error;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(
        Effect.tapError(() =>
          newRowLeft
            ? Effect.logError(
                "Refresh rotation could not remove its own new session after a failed write",
              ).pipe(Effect.annotateLogs({ restricted: String(restrictedUntil !== null) }))
            : Effect.void,
        ),
      );

      if (written.swapped === 0) {
        // Lost: the old row was present at verify but gone, or the new one
        // gone, by the swap. A concurrent grant of this SAME token rotated it
        // (two tabs bootstrapping on reload, a cold-start bootstrap racing a
        // 401-refresh, a retried grant), or a delete took the family or the
        // account mid-grant. Never reuse: a replay of an already-rotated token
        // fails `verifyRefreshToken` and goes down `detectReuse` instead. The
        // family is preserved; this grant removes what it wrote — its new row,
        // and its record when that record landed, since the key is unique and
        // so the row is this request's — and fails.
        yield* Effect.tryPromise({
          try: () =>
            commitBatch(db, [
              db.delete(sessions).where(newRow),
              ...(written.recorded === 1
                ? [db.delete(rotatedSessions).where(eq(rotatedSessions.tokenHash, oldSessionId))]
                : []),
            ]),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricSessionRotationRace();
        yield* Effect.logInfo(
          "Refresh rotation CAS lost to a concurrent grant — benign race, family preserved",
        );
        // Distinct from the "this token does not verify" failures above:
        // `POST /token` does not retract the session marker here. A winner's
        // cookie is alive; after a revoke the next grant answers "Invalid or
        // expired session", which does retract it. See `lib/grant-failure`.
        return yield* Effect.fail(new AuthError({ message: ROTATION_RACE_MESSAGE }));
      }

      return {
        accessToken,
        refreshToken: newSessionToken,
        expiresIn: sessionBoundTtl(restrictedUntil, nowSec),
      };
    }).pipe(withSessionRotation, withAuthTokenRefresh);

  // -------------------------------------------------------------------------
  // Verify access token (for protected routes)
  // -------------------------------------------------------------------------

  /**
   * Verifies an access-shaped JWT and pins its `aud` to `audience`.
   *
   * **Deliberately private.** Only two bindings exist — {@link verifyAccessToken}
   * and {@link verifyRecoveryAccessToken} — and neither is parameterised on the
   * service surface. A public "verify with whatever audience you like" is one
   * careless call away from a caller accepting the recovery audience at a route
   * the restriction exists to keep it out of.
   */
  const verifyTokenWithAudience = (
    token: string,
    audience: string,
  ): Effect.Effect<
    {
      profileId: string;
      email: string;
      handle: string;
      displayName: string | null;
      sessionBinding: string | null;
    },
    AuthError
  > =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtPublicKey, config.issuerUrl),
        catch: () => new AuthError({ message: "Invalid or expired access token" }),
      });
      if (
        typeof payload["sub"] !== "string" ||
        typeof payload["email"] !== "string" ||
        typeof payload["handle"] !== "string" ||
        payload["aud"] !== audience
      ) {
        // Pinning `aud` means only a token issued for this audience
        // authenticates here. Without it any ES256 JWT this issuer signed
        // with string sub/email/handle would be accepted.
        return yield* Effect.fail(new AuthError({ message: "Invalid token claims" }));
      }
      return {
        profileId: payload["sub"],
        email: payload["email"],
        handle: payload["handle"],
        displayName: typeof payload["displayName"] === "string" ? payload["displayName"] : null,
        // Absent on tokens minted before this claim existed, and on any
        // future path that mints one outside a session. Callers must treat
        // null as "session unknown", never as "no session".
        sessionBinding: typeof payload["osn_sid"] === "string" ? payload["osn_sid"] : null,
      };
    });

  /** The ordinary access-token verifier. Every route but passkey enrolment. */
  const verifyAccessToken = (token: string) =>
    verifyTokenWithAudience(token, ACCESS_TOKEN_AUDIENCE);

  /**
   * Verifies a restricted recovery session's access token.
   *
   * `resolvePasskeyEnrollPrincipal` is the only caller, and it tries
   * {@link verifyAccessToken} first — so an ordinary token never reaches here,
   * and a route that adopts this by mistake gets a token that can do exactly
   * one thing rather than one that can do everything.
   */
  const verifyRecoveryAccessToken = (token: string) =>
    verifyTokenWithAudience(token, RECOVERY_TOKEN_AUDIENCE);

  /**
   * Lifts the restriction from a recovery session, turning it into an ordinary
   * one: `restrictedUntil` is cleared and the absolute 15-minute deadline is
   * replaced by a normal sliding TTL. Called by `completePasskeyRegistration`,
   * because enrolling a passkey is the one thing a restricted session exists to
   * do and the user has just done it.
   *
   * Four predicates, and each closes a different way this write could grant
   * more than it means to:
   *
   *  - in the family of the live session `sessionHash` names
   *    ({@link inLiveFamilyOf}) — the caller's own device, server-derived. A
   *    refresh of that session in flight has inserted its new session,
   *    restricted, before it deletes the old one, and the family reaches it;
   *    a refresh that inserts after this write copies the lifted row. A hash
   *    a refresh has already replaced names no live session and lifts
   *    nothing: a lift is a grant, and a rotated-out hash grants nothing.
   *    `completePasskeyRegistration` then sweeps with the same hash, which
   *    spares only a live session's family, so the replacement goes with
   *    every other session rather than staying restricted. Either way no
   *    restricted session of the caller's device outlives the enrolment.
   *  - `account_id = accountId` — scoped like every other session write that
   *    takes a hash (`invalidateOtherAccountSessions`, `revokeAccountSession`),
   *    so a hash belonging to another account can never be lifted through a
   *    caller who does not own it.
   *  - `restricted_until IS NOT NULL` keeps this off the ordinary path: an
   *    everyday passkey add must not have its session's expiry quietly reset.
   *  - `expires_at > now` — the 15-minute deadline is absolute, and nothing
   *    revives a row that has passed it. `liveSessionIds` has no expiry term,
   *    so a restricted row an instant past its deadline still classifies as the
   *    caller's session, and without this the enrolment would convert it into
   *    an ordinary 30-day one. Expiry is otherwise enforced in
   *    `verifyRefreshToken`, which this path never calls.
   *
   * A `null` hash is a no-op — that caller had no identifiable session, and
   * `completePasskeyRegistration` then revokes every session on the account,
   * restricted one included.
   */
  const liftSessionRestriction = (
    accountId: string,
    sessionHash: string | null,
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      if (!sessionHash) return;
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(sessions)
            .set({
              restrictedUntil: null,
              restrictedAmr: null,
              expiresAt: nowSec + refreshTokenTtl,
            })
            .where(
              and(
                inLiveFamilyOf(db, sessionHash),
                eq(sessions.accountId, accountId),
                isNotNull(sessions.restrictedUntil),
                gt(sessions.expiresAt, nowSec),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(Effect.withSpan("auth.session.lift_restriction"));

  return {
    issueAccessToken,
    issueTokens,
    issueRecoverySession,
    reserveSession,
    makeRoomForReservation,
    claimReservation,
    verifyRefreshToken,
    refreshTokens,
    verifyAccessToken,
    verifyRecoveryAccessToken,
    liftSessionRestriction,
  };
}

export type TokensModule = ReturnType<typeof createTokensModule>;
