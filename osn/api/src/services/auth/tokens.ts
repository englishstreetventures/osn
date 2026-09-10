/**
 * Token issuance, server-side session refresh + rotation (Copenhagen Book
 * C1), rotated-token reuse detection (C2), and access-token verification.
 */

import { sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { rowsChanged } from "@shared/db-utils";
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import { ROTATION_RACE_MESSAGE } from "../../lib/grant-failure";
import type { RotatedHashRecord } from "../../lib/rotated-session-store";
import {
  metricRotatedStoreDuration,
  metricRotatedStoreOp,
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
import type { ProfilesModule } from "./profiles";
import type { RecoveryFactorAmr, SessionMeta, TokenSet } from "./types";

export function createTokensModule(ctx: AuthContext, profiles: ProfilesModule) {
  const {
    config,
    accessTokenTtl,
    refreshTokenTtl,
    rotatedSessionStore,
    rotatedSessionStoreBackend,
    hashIp,
    passkeyRegisterAllowedAmr,
  } = ctx;
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
        // P6 invariant: `accountId` is intentionally absent from the
        // access-token payload. Including it would allow any external
        // observer (a downstream service, a JWT decoder in the browser,
        // a leaked log line) to correlate two profiles as belonging to
        // the same account. S-H2 is solved server-to-server instead —
        // `/internal/step-up/verify` re-issues the verified accountId
        // back to the calling service over an ARC-authenticated channel.
        const payload: AccessTokenClaims = {
          sub: profileId,
          aud: audience,
          email,
          handle,
          scope: "openid profile",
        };
        if (displayName !== null) payload["displayName"] = displayName;
        // S-L3: session binding. One-way, per-profile (see
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

      const { db } = yield* Db;

      // S-M1: LRU-evict the oldest sessions once the per-account cap is
      // exceeded. An attacker with a stolen credential can't inflate the
      // revocation surface beyond MAX_SESSIONS_PER_ACCOUNT; legitimate
      // users with genuinely many devices see their least-recently-used
      // sessions drop off rather than their new login failing.
      yield* Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ id: sessions.id, lastUsedAt: sessions.lastUsedAt })
            .from(sessions)
            .where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT + 1);
          if (rows.length >= MAX_SESSIONS_PER_ACCOUNT) {
            const evictIds = rows.slice(MAX_SESSIONS_PER_ACCOUNT - 1).map((r) => r.id);
            await db.delete(sessions).where(inArray(sessions.id, evictIds));
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

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
   * Returns `accountId`, `familyId`, and `sessionId` (the hash). The
   * `familyId` is needed by `refreshTokens` for rotation; `sessionId` is
   * needed by `invalidateOtherAccountSessions` (H1). The device metadata
   * (`createdAt`, `uaLabel`, `ipHash`) rides along from the row loaded here so
   * `refreshTokens` can carry it onto the rotated-in row without re-reading
   * the same row by primary key (P-W1).
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
      createdAt: number;
      uaLabel: string | null;
      ipHash: string | null;
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

      // Expired — clean up lazily
      if (nowSec >= session.expiresAt) {
        yield* Effect.tryPromise({
          try: () => db.delete(sessions).where(eq(sessions.id, sessionId)),
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
      // `last_used_at` is coalesced (P-W4) — writing it on every verify
      // would add a DB round-trip per refresh. The Sessions UI doesn't
      // need sub-second accuracy; 60 s granularity shrinks writes by
      // roughly the refresh cadence.
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
      // `createdAt` for legacy rows). It is the honest `auth_time` for the OIDC
      // provider (S-H1 oidc): a 29-day-old passkey ceremony reads as 29 days
      // old even after dozens of silent refreshes, so a relying party's
      // `max_age` reflects real user presence, not the last background refresh.
      return {
        accountId: session.accountId,
        familyId: session.familyId,
        sessionId,
        authenticatedAt: session.authenticatedAt ?? session.createdAt,
        createdAt: session.createdAt,
        uaLabel: session.uaLabel,
        ipHash: session.ipHash,
        restrictedUntil: session.restrictedUntil,
        restrictedAmr: session.restrictedAmr,
      };
    });

  // -------------------------------------------------------------------------
  // Reuse detection (Copenhagen Book C2)
  //
  // When a session hash is not found in the DB, it may have been rotated
  // out (deleted during a prior refresh). `rotatedSessionStore` tracks
  // recently-rotated hashes (keyed by hash → familyId) so a replayed
  // old token triggers full family revocation. S-H1 session: the store
  // abstraction lets the memory default (single-process dev/test) swap for
  // a Redis-backed cluster-safe implementation in production.
  // -------------------------------------------------------------------------

  const rotatedSessionStoreTtlMs = refreshTokenTtl * 1000;

  /**
   * Record a rotated-out hash. Wraps the async store call with the standard
   * observability trio: span + duration histogram + bounded-attrs counter.
   * Fail-open on store errors — rotation itself has already committed at
   * the DB layer and aborting the refresh on a Redis blip is a worse UX
   * than a temporary gap in reuse detection.
   */
  const trackRotatedSession = (
    sessionHash: string,
    familyId: string,
  ): Effect.Effect<void, never, never> =>
    Effect.suspend(() => {
      const start = Date.now();
      return Effect.tryPromise({
        try: () => rotatedSessionStore.track(sessionHash, familyId, rotatedSessionStoreTtlMs),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            metricRotatedStoreOp({
              action: "track",
              result: "ok",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "track",
              backend: rotatedSessionStoreBackend,
            });
          }),
        ),
        Effect.catch(() =>
          Effect.gen(function* () {
            metricRotatedStoreOp({
              action: "track",
              result: "error",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "track",
              backend: rotatedSessionStoreBackend,
            });
            yield* Effect.logWarning("Rotated-session store unreachable — fail-open on track");
          }),
        ),
        Effect.withSpan("auth.session.rotated_store.track"),
      );
    });

  /**
   * Checks if a missing session hash was recently rotated. If so, revokes
   * the entire family — both the legitimate holder and the attacker are
   * logged out, which is the correct security response per the Copenhagen
   * Book.
   */
  const detectReuse = (sessionHash: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const start = Date.now();
      const record = yield* Effect.tryPromise({
        try: () => rotatedSessionStore.check(sessionHash),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            metricRotatedStoreOp({
              action: "check",
              result: result ? "hit" : "miss",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "check",
              backend: rotatedSessionStoreBackend,
            });
          }),
        ),
        Effect.catch(() =>
          Effect.gen(function* () {
            metricRotatedStoreOp({
              action: "check",
              result: "error",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "check",
              backend: rotatedSessionStoreBackend,
            });
            yield* Effect.logWarning("Rotated-session store unreachable — fail-open on check");
            // Fail-open: return null so a Redis outage cannot manufacture
            // false-positive family revocations that log legitimate users out.
            return null as RotatedHashRecord | null;
          }),
        ),
        Effect.withSpan("auth.session.rotated_store.check"),
      );
      if (!record) return;

      // Grace window: a rotated-out hash replayed within ROTATION_GRACE_MS of
      // its rotation is benign concurrency — a legitimate client fired two
      // near-simultaneous grants of the same token (multi-tab reload, a
      // bootstrap racing a 401-refresh) or retried after a lost response. The
      // winning grant already rotated the family forward; this replay just
      // loses. Treat it as a race, NOT reuse — preserve the family so the user
      // stays signed in. A replay OUTSIDE the window is genuine reuse below.
      if (Date.now() - record.rotatedAtMs < ROTATION_GRACE_MS) {
        metricSessionRotationRace();
        yield* Effect.logInfo(
          "Rotated-token replay within grace window — benign concurrent refresh, family preserved",
        );
        return;
      }

      // Replayed rotated-out token outside the grace window — revoke the family.
      const { familyId } = record;
      metricSessionReuseDetected();
      yield* Effect.logWarning("Session token reuse detected — revoking family");
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.familyId, familyId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // S-M1: clear every tracking record for this family so observability
      // stays consistent if an attacker replays multiple exfiltrated tokens
      // from the same chain. Store-level fail-open — leaving stale keys
      // behind is harmless (they expire with the refresh TTL).
      const revokeStart = Date.now();
      yield* Effect.tryPromise({
        try: () => rotatedSessionStore.revokeFamily(familyId),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            metricRotatedStoreOp({
              action: "revoke_family",
              result: "ok",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - revokeStart) / 1000, {
              action: "revoke_family",
              backend: rotatedSessionStoreBackend,
            });
          }),
        ),
        Effect.catch(() =>
          Effect.gen(function* () {
            metricRotatedStoreOp({
              action: "revoke_family",
              result: "error",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - revokeStart) / 1000, {
              action: "revoke_family",
              backend: rotatedSessionStoreBackend,
            });
            yield* Effect.logWarning(
              "Rotated-session store unreachable — fail-open on revoke_family",
            );
          }),
        ),
        Effect.withSpan("auth.session.rotated_store.revoke_family"),
      );
      metricSessionFamilyRevoked();
    }).pipe(Effect.withSpan("auth.session.reuse_detect"));

  /**
   * Refreshes a session: verifies the session token, finds the default
   * profile, issues a new access token, and **rotates** the session token
   * (Copenhagen Book C2). The old session row is deleted and a new one is
   * inserted in the same family. The old hash is tracked in-memory so that
   * a replayed old token triggers full family revocation (reuse detection).
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
        authenticatedAt,
        uaLabel,
        ipHash,
        restrictedUntil,
        restrictedAmr,
        // The one caller allowed to rotate a restricted session — rotating it
        // is the only thing a restricted session is for.
      } = yield* verifyRefreshToken(sessionToken, { allowRestricted: true });
      const profile = yield* findDefaultProfile(accountId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }

      // Rotate: delete old session, insert new one in the same family,
      // preserving the old session's metadata (UA label + IP hash) so the
      // device keeps its identity across rotations. The new session id is
      // minted first so the access token binds to the session the caller
      // will actually hold after this grant, not the one being rotated out.
      const newSessionToken = generateSessionToken();
      const newSessionId = hashSessionToken(newSessionToken);

      // One clock read, taken before the mint so the token's lifetime is
      // measured against the same instant as the row fields below.
      const nowSec = Math.floor(Date.now() / 1000);

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
      // The old session's metadata (UA label + IP hash + `authenticatedAt`)
      // comes from the row `verifyRefreshToken` already loaded, so the
      // rotated-in row keeps the device's identity without a second read of
      // the same primary key (P-W1).

      // CAS gate (S-M refresh-rotation): the old-session DELETE is the atomic
      // compare-and-swap. Two concurrent refreshes of the same token both pass
      // verification, but only one DELETE observes the row present (rows-affected
      // == 1) and proceeds to insert; the loser sees 0 rows — the token was
      // already rotated out (concurrent refresh or replay), which is treated as
      // C2 reuse: revoke the whole family instead of minting a sibling session.
      // Mirrors the recovery-code CAS already used in this service.
      //
      // Rows-affected goes through `rowsChanged` — D1 reports it under
      // `meta.changes`, and reading only the top-level field made this gate
      // read 0 for every grant in production (the DELETE had already run), so
      // every refresh destroyed the session it was renewing.
      const delResult = yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.id, oldSessionId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const rotated = rowsChanged(delResult);

      if (rotated === 0) {
        // CAS lost: the row was PRESENT at verify but GONE by DELETE, so a
        // CONCURRENT grant of this SAME token rotated it out in the gap. This
        // is NOT reuse: a replay of an already-rotated token can't pass
        // `verifyRefreshToken` (its row is absent) and never reaches here —
        // only concurrent use of the *current* token does (two tabs
        // bootstrapping on reload, a cold-start bootstrap racing a 401-refresh,
        // a retried grant). The winning grant already rotated the family
        // forward and its new session is valid; revoking the family here was a
        // false positive that logged legitimate users out across every device
        // (the "logs out sometimes" bug). Preserve the family — this losing
        // grant simply fails, and its client re-establishes from the (rotated)
        // cookie the winner set.
        metricSessionRotationRace();
        yield* Effect.logInfo(
          "Refresh rotation CAS lost to a concurrent grant — benign race, family preserved",
        );
        // Distinct from the "this token does not verify" failures above, and
        // deliberately so: `POST /token` must NOT retract the session marker
        // here. The cookie the winner set is alive; only this losing grant
        // failed. See `lib/grant-failure` (S-M2).
        return yield* Effect.fail(new AuthError({ message: ROTATION_RACE_MESSAGE }));
      }

      yield* Effect.tryPromise({
        try: () =>
          db.insert(sessions).values({
            id: newSessionId,
            accountId,
            familyId,
            // A restricted session keeps its ORIGINAL absolute deadline across
            // every rotation. `nowSec + refreshTokenTtl` here would hand a
            // 30-day life to the session that must die in fifteen minutes, and
            // the client refreshes silently, so it would happen on its own.
            expiresAt: restrictedUntil ?? nowSec + refreshTokenTtl,
            createdAt: nowSec,
            // Preserve the device's original authentication time across the
            // rotation. `createdAt` is the new row's insert time (this grant),
            // but `authenticatedAt` must reflect the real passkey/OTP ceremony
            // so a background silent refresh can't reset `auth_time` to "now"
            // and satisfy a relying party's `max_age` with zero user presence.
            // Fall back to the old row's `createdAt` for sessions minted before
            // the column existed — `verifyRefreshToken` already applied that
            // fallback, so this value is never null.
            authenticatedAt,
            uaLabel,
            ipHash,
            lastUsedAt: nowSec,
            restrictedUntil,
            // Carried forward with the deadline: the enrolment bypass reads the
            // factor off whichever row the caller currently holds, and a
            // rotation that dropped it would silently retire the bypass.
            restrictedAmr,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Track the rotated-out hash for reuse detection
      yield* trackRotatedSession(oldSessionId, familyId);

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
        // S-M2: `aud` pinning ensures only tokens explicitly issued as
        // access tokens authenticate these routes. Without it any ES256
        // JWT with string sub/email/handle would be accepted.
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
   *  - `id = sessionHash` — the caller's own session, server-derived.
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
   * `completePasskeyRegistration` has already revoked every session on the
   * account, restricted one included.
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
                eq(sessions.id, sessionHash),
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
    verifyRefreshToken,
    refreshTokens,
    verifyAccessToken,
    verifyRecoveryAccessToken,
    liftSessionRestriction,
  };
}

export type TokensModule = ReturnType<typeof createTokensModule>;
