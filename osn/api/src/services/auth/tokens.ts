/**
 * Token issuance, server-side session refresh + rotation (Copenhagen Book
 * C1), rotated-token reuse detection (C2), and access-token verification.
 */

import { sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { rowsChanged } from "@shared/db-utils";
import { desc, eq, inArray } from "drizzle-orm";
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
import { LAST_USED_AT_COALESCE_MS, MAX_SESSIONS_PER_ACCOUNT, ROTATION_GRACE_MS } from "./constants";
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
import type { SessionMeta, TokenSet } from "./types";

export function createTokensModule(ctx: AuthContext, profiles: ProfilesModule) {
  const {
    config,
    accessTokenTtl,
    refreshTokenTtl,
    rotatedSessionStore,
    rotatedSessionStoreBackend,
    hashIp,
  } = ctx;
  const { findDefaultProfile } = profiles;

  // -------------------------------------------------------------------------
  // Token issuance
  // -------------------------------------------------------------------------

  // Access-token audience (S-M2). Asserted in `verifyAccessToken` so an
  // ES256 token signed with the same key but minted for a different
  // audience (step-up, or any future type) cannot authenticate access-
  // token routes. Mirrors STEP_UP_AUDIENCE below.
  const ACCESS_TOKEN_AUDIENCE = "osn-access";

  /**
   * Signs a short-lived ES256 access token JWT. Used by both initial login
   * (via `issueTokens`) and token refresh / profile switch (standalone).
   */
  const issueAccessToken = (
    profileId: string,
    email: string,
    handle: string,
    displayName: string | null,
    sessionBinding?: string | null,
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
          aud: ACCESS_TOKEN_AUDIENCE,
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
        return signJwt(
          payload,
          config.jwtPrivateKey,
          config.jwtKid,
          accessTokenTtl,
          config.issuerUrl,
        );
      },
      catch: (cause) => new AuthError({ message: String(cause) }),
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
  const issueTokens = (
    profileId: string,
    accountId: string,
    email: string,
    handle: string,
    displayName: string | null,
    familyId?: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<TokenSet, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Generate opaque session token + store SHA-256 hash in DB. This runs
      // BEFORE the access token is signed: the JWT carries a binding to the
      // session it was minted from (`osn_sid`).
      const sessionToken = generateSessionToken();
      const sessionId = hashSessionToken(sessionToken);
      const accessToken = yield* issueAccessToken(
        profileId,
        email,
        handle,
        displayName,
        deriveSessionBinding(sessionId, profileId),
      );
      const nowSec = Math.floor(Date.now() / 1000);
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
            expiresAt: nowSec + refreshTokenTtl,
            createdAt: nowSec,
            // First authentication on this device. Copied forward on every
            // rotation so `auth_time`/`max_age` stay honest across silent refresh.
            authenticatedAt: nowSec,
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
            lastUsedAt: nowSec,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return { accessToken, refreshToken: sessionToken, expiresIn: accessTokenTtl };
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
   * needed by `invalidateOtherAccountSessions` (H1).
   *
   * Shared by `refreshTokens`, `switchProfile`, and `listAccountProfiles`.
   */
  const verifyRefreshToken = (
    token: string,
  ): Effect.Effect<
    { accountId: string; familyId: string; sessionId: string; authenticatedAt: number },
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

      // Sliding window: extend when less than half the TTL remains.
      // `last_used_at` is coalesced (P-W4) — writing it on every verify
      // would add a DB round-trip per refresh. The Sessions UI doesn't
      // need sub-second accuracy; 60 s granularity shrinks writes by
      // roughly the refresh cadence.
      const halfTtl = Math.floor(refreshTokenTtl / 2);
      const shouldExtend = session.expiresAt - nowSec < halfTtl;
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
        Effect.catchAll(() =>
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
        Effect.catchAll(() =>
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
        Effect.catchAll(() =>
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
      } = yield* verifyRefreshToken(sessionToken);
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

      const accessToken = yield* issueAccessToken(
        profile.id,
        profile.email,
        profile.handle,
        profile.displayName,
        deriveSessionBinding(newSessionId, profile.id),
      );
      const nowSec = Math.floor(Date.now() / 1000);

      const { db } = yield* Db;
      // Read the old session's metadata up front (D1 has no interactive
      // transaction) so the rotated-in row keeps the device's UA label + IP hash.
      const existing = yield* Effect.tryPromise({
        try: () => db.select().from(sessions).where(eq(sessions.id, oldSessionId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const old = existing[0];

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
            expiresAt: nowSec + refreshTokenTtl,
            createdAt: nowSec,
            // Preserve the device's original authentication time across the
            // rotation. `createdAt` is the new row's insert time (this grant),
            // but `authenticatedAt` must reflect the real passkey/OTP ceremony
            // so a background silent refresh can't reset `auth_time` to "now"
            // and satisfy a relying party's `max_age` with zero user presence.
            // Fall back to the old row's `createdAt` for sessions minted before
            // the column existed.
            authenticatedAt: old?.authenticatedAt ?? old?.createdAt ?? nowSec,
            uaLabel: old?.uaLabel ?? null,
            ipHash: old?.ipHash ?? null,
            lastUsedAt: nowSec,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Track the rotated-out hash for reuse detection
      yield* trackRotatedSession(oldSessionId, familyId);

      return { accessToken, refreshToken: newSessionToken, expiresIn: accessTokenTtl };
    }).pipe(withSessionRotation, withAuthTokenRefresh);

  // -------------------------------------------------------------------------
  // Verify access token (for protected routes)
  // -------------------------------------------------------------------------

  const verifyAccessToken = (
    token: string,
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
        payload["aud"] !== ACCESS_TOKEN_AUDIENCE
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

  return {
    issueAccessToken,
    issueTokens,
    verifyRefreshToken,
    refreshTokens,
    verifyAccessToken,
  };
}

export type TokensModule = ReturnType<typeof createTokensModule>;
