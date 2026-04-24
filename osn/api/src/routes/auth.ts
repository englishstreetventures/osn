import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import type { AuthRateLimitedEndpoint } from "@shared/observability/metrics";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../lib/auth-derive";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  readSessionCookie,
  type CookieSessionConfig,
} from "../lib/cookie-session";
import { publicError } from "../lib/public-error";
import { deriveUaLabel } from "../lib/ua-label";
import { metricAuthJwksServed, metricAuthRateLimited } from "../metrics";
import { createAuthService, type AuthConfig } from "../services/auth";

/**
 * Typed map of every rate limiter the auth routes consume. Split out as a
 * named type so the Redis migration (Phase 2) can supply a mixed bag of
 * Redis-backed and in-memory backends per endpoint without touching
 * `createAuthRoutes` call sites.
 */
export type AuthRateLimiters = Readonly<{
  registerBegin: RateLimiterBackend;
  registerComplete: RateLimiterBackend;
  handleCheck: RateLimiterBackend;
  passkeyLoginBegin: RateLimiterBackend;
  passkeyLoginComplete: RateLimiterBackend;
  passkeyRegisterBegin: RateLimiterBackend;
  passkeyRegisterComplete: RateLimiterBackend;
  profileSwitch: RateLimiterBackend;
  profileList: RateLimiterBackend;
  /** Recovery code generation (authenticated) — per-account quota. */
  recoveryGenerate: RateLimiterBackend;
  /** Recovery code login — per-IP quota, stricter than normal login completers. */
  recoveryComplete: RateLimiterBackend;
  /** Step-up passkey begin (authenticated, issues a challenge). */
  stepUpPasskeyBegin: RateLimiterBackend;
  /** Step-up passkey complete (authenticated, consumes assertion). */
  stepUpPasskeyComplete: RateLimiterBackend;
  /** Step-up OTP begin (authenticated, sends email). */
  stepUpOtpBegin: RateLimiterBackend;
  /** Step-up OTP complete (authenticated, verifies code). */
  stepUpOtpComplete: RateLimiterBackend;
  /** Session list (authenticated, per-user). */
  sessionList: RateLimiterBackend;
  /** Session revoke (authenticated, per-user). */
  sessionRevoke: RateLimiterBackend;
  /** Email change begin (authenticated, sends OTP to new email). */
  emailChangeBegin: RateLimiterBackend;
  /** Email change complete (authenticated, verifies OTP + step-up). */
  emailChangeComplete: RateLimiterBackend;
  /** Security event list (authenticated, per-user). */
  securityEventList: RateLimiterBackend;
  /** Security event acknowledge (authenticated, per-user). */
  securityEventAck: RateLimiterBackend;
  /** Passkey list (authenticated, per-user). */
  passkeyList: RateLimiterBackend;
  /** Passkey rename (authenticated, per-user). */
  passkeyRename: RateLimiterBackend;
  /** Passkey delete (authenticated, per-user — step-up is the primary gate). */
  passkeyDelete: RateLimiterBackend;
  /** Cross-device login begin (unauthenticated, per-IP). */
  crossDeviceBegin: RateLimiterBackend;
  /** Cross-device login poll (unauthenticated, per-IP — higher budget for 2s polling). */
  crossDevicePoll: RateLimiterBackend;
  /** Cross-device login approve (authenticated, per-IP). */
  crossDeviceApprove: RateLimiterBackend;
  /** Cross-device login reject (authenticated, per-IP). */
  crossDeviceReject: RateLimiterBackend;
}>;

/**
 * Default in-memory rate limiter bundle used when callers don't pass an
 * explicit `rateLimiters` override. Limits match the values documented in
 * CLAUDE.md > Rate Limiting (S-H1): 5 req/IP/min on send endpoints, 10
 * req/IP/min on verify/complete endpoints.
 */
export function createDefaultAuthRateLimiters(): AuthRateLimiters {
  return {
    registerBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    registerComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    handleCheck: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyLoginBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyLoginComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyRegisterBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyRegisterComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    profileSwitch: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    profileList: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Recovery generation: the step-up gate is now the primary defence
    // against stolen-access-token abuse (superseding the per-day cap
    // relied on previously for S-M1). Keep a coarse per-IP throttle in
    // place so the endpoint isn't trivially floodable.
    recoveryGenerate: createRateLimiter({ maxRequests: 10, windowMs: 3_600_000 }),
    // Recovery login is an IP-side limit; the underlying DB hash comparison
    // is already constant-time, but per-IP throttling curbs online brute
    // force across different account identifiers.
    recoveryComplete: createRateLimiter({ maxRequests: 5, windowMs: 3_600_000 }),
    // Step-up ceremonies: treat like login completers. A misbehaving
    // browser that keeps retrying a bad OTP shouldn't be able to burn
    // through codes faster than a human.
    stepUpPasskeyBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    stepUpPasskeyComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    stepUpOtpBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    stepUpOtpComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    sessionList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    sessionRevoke: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Email change begin is tightly capped because each call sends mail
    // to a user-controlled address — uncapped it would be an open relay
    // for an authenticated attacker.
    emailChangeBegin: createRateLimiter({ maxRequests: 3, windowMs: 3_600_000 }),
    emailChangeComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Security events (M-PK1b): cheap reads and idempotent acks. Mirror the
    // sessionList budget for the listing surface; ack is a single-row update
    // and only dismisses a banner, so a generous per-minute allowance.
    securityEventList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    securityEventAck: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Passkey management (M-PK). Listing is cheap; rename / delete are
    // infrequent settings actions. Delete has an additional step-up gate.
    passkeyList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    passkeyRename: createRateLimiter({ maxRequests: 20, windowMs: 60_000 }),
    passkeyDelete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    crossDeviceBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    crossDevicePoll: createRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    crossDeviceApprove: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    crossDeviceReject: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
  };
}

/**
 * Convert a TokenSet to wire format WITHOUT the refresh token (S-M2).
 * Used for first-party flows where the refresh token is in the HttpOnly cookie.
 * Omitting it from the body prevents XSS exfiltration of the session token.
 */
function toTokenResponseCookieOnly(ts: { accessToken: string; expiresIn: number }) {
  return {
    access_token: ts.accessToken,
    token_type: "Bearer" as const,
    expires_in: ts.expiresIn,
    scope: "openid profile",
  };
}

export function createAuthRoutes(
  authConfig: AuthConfig,
  /**
   * Service layer supplying `Db` and `EmailService`. Defaults to
   * `DbLive` merged with a fresh `LogEmailLive` (local dev + tests).
   * Production callers compose `DbLive` with `makeCloudflareEmailLive(...)`.
   */
  dbLayer: Layer.Layer<Db | EmailService> = Layer.merge(DbLive, makeLogEmailLive().layer),
  /**
   * Optional observability layer. When provided, per-request Effect pipelines
   * (including `Effect.logDebug` in the dev-mode OTP / magic-link branches
   * inside `auth.ts`) run with the application's logger + tracing wiring. When
   * omitted, defaults to `Layer.empty` — the service still runs correctly but
   * debug-level logs are dropped by Effect's default logger, so dev OTP/magic
   * values are not visible unless the host application wires this in. See
   * `osn/app/src/index.ts` for the canonical wiring.
   */
  loggerLayer: Layer.Layer<never> = Layer.empty,
  /**
   * Rate limiter backends for every auth endpoint group. Defaults to a fresh
   * in-memory bundle via `createDefaultAuthRateLimiters()`. Phase 2 of the
   * Redis migration will construct Redis-backed bundles at the host
   * application (`osn/app/src/index.ts`) and inject them here.
   */
  rateLimiters: AuthRateLimiters = createDefaultAuthRateLimiters(),
  /**
   * Cookie session config (C3). Controls whether session tokens are set
   * as HttpOnly cookies with the Secure flag. Defaults to non-secure
   * (local dev mode).
   */
  cookieConfig: CookieSessionConfig = { secure: false },
) {
  // Fail-fast: validate every limiter slot at construction time (S-L2) so a
  // partially-valid object surfaces immediately instead of on the first
  // request to a rarely-hit endpoint.
  for (const [key, backend] of Object.entries(rateLimiters)) {
    if (typeof (backend as RateLimiterBackend)?.check !== "function") {
      throw new Error(`AuthRateLimiters.${key} must have a check() method`);
    }
  }

  // P-I2: pre-build the static JWKS response once at route construction time.
  // The key does not change during the server's lifetime — no need to allocate
  // a new object (and spread-copy all JWK fields) on every request.
  // S-L2: include key_ops alongside use for RFC 7517 compliance.
  const jwksResponse = {
    keys: [
      {
        ...authConfig.jwtPublicKeyJwk,
        use: "sig",
        alg: "ES256",
        kid: authConfig.jwtKid,
        key_ops: ["verify"],
      },
    ],
  } as const;

  const auth = createAuthService(authConfig);

  const run = <A, E>(eff: Effect.Effect<A, E, Db | EmailService>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  /**
   * Extracts the caller's coarse UA label + client IP from incoming headers
   * so `issueTokens` can persist them onto the new session row. Both fields
   * are best-effort — missing headers just yield `null` downstream.
   */
  const sessionMetaFrom = (headers: Record<string, string | undefined>) => ({
    uaLabel: deriveUaLabel(headers["user-agent"]),
    ip: (() => {
      const ip = getClientIp(headers);
      return ip === "unknown" ? null : ip;
    })(),
  });

  // ---------------------------------------------------------------------------
  // IP-based rate limiters (S-H1). Injected via the `rateLimiters` parameter
  // so callers can swap in Redis-backed backends at composition time.
  // ---------------------------------------------------------------------------

  const rl = rateLimiters;

  // Async to accommodate future Redis backends where `check()` returns a Promise.
  // In-memory backends resolve immediately; `await` on a non-Promise is a no-op.
  // Fail-closed (S-M1): if the backend rejects, treat it as rate-limited so a
  // Redis outage blocks rather than bypasses the limiter.
  async function rateLimit(
    headers: Record<string, string | undefined>,
    endpoint: AuthRateLimitedEndpoint,
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = getClientIp(headers);
    let allowed: boolean;
    try {
      allowed = await limiter.check(ip);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    return null;
  }

  /**
   * Resolves the authenticated principal for /passkey/register/* calls.
   * The caller must present a Bearer access token whose `sub` matches the
   * body `profileId`; we resolve `accountId` via a DB lookup. New users
   * enroll their first passkey using the access token issued by
   * `/register/complete`; existing users add additional passkeys using a
   * normal session access token.
   */
  type Principal = { unauthorized: true } | { unauthorized: false; accountId: string };
  async function resolvePasskeyEnrollPrincipal(
    authHeader: string | undefined,
    bodyProfileId: string,
  ): Promise<Principal> {
    const claims = await resolveAccessTokenPrincipal(auth, authHeader);
    if (!claims || claims.profileId !== bodyProfileId) return { unauthorized: true };
    const profile = await run(auth.findProfileById(bodyProfileId));
    if (!profile) return { unauthorized: true };
    return { unauthorized: false, accountId: profile.accountId };
  }

  return (
    new Elysia({ prefix: "" })
      // -------------------------------------------------------------------------
      // Handle availability check
      // -------------------------------------------------------------------------
      .get(
        "/handle/:handle",
        async ({ params, set, headers }) => {
          const rlErr = await rateLimit(headers, "handle_check", rl.handleCheck);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(auth.checkHandle(params.handle));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          params: t.Object({ handle: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Email-verified registration: begin (sends OTP, does not create profile)
      //
      // Always returns `{ sent: true }` (or a public error code on validation
      // failure) regardless of whether the email/handle is already taken —
      // this removes the user-enumeration oracle (S-M1).
      // -------------------------------------------------------------------------
      .post(
        "/register/begin",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(headers, "register_begin", rl.registerBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            return await run(auth.beginRegistration(body.email, body.handle, body.displayName));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            email: t.String(),
            handle: t.String(),
            displayName: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Email-verified registration: complete (verifies OTP, creates account + profile)
      //
      // Returns access + refresh tokens directly. The UI immediately uses the
      // returned access token to drive `/passkey/register/{begin,complete}`
      // and attests the user's first passkey. The UI refuses to dismiss
      // until enrollment succeeds; `deletePasskey` refuses to drop below 1.
      // -------------------------------------------------------------------------
      .post(
        "/register/complete",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(headers, "register_complete", rl.registerComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.completeRegistration(body.email, body.code, sessionMetaFrom(headers)),
            );
            set.status = 201;
            set.headers["set-cookie"] = buildSessionCookie(result.refreshToken, cookieConfig);
            return {
              profileId: result.profileId,
              handle: result.handle,
              email: result.email,
              session: toTokenResponseCookieOnly(result),
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            email: t.String(),
            code: t.String(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Token endpoint — refresh grant only (session token in HttpOnly cookie)
      // -------------------------------------------------------------------------
      .post(
        "/token",
        async ({ body, set, headers }) => {
          const { grant_type } = body as { grant_type: string };

          if (grant_type !== "refresh_token") {
            set.status = 400;
            return { error: "unsupported_grant_type" };
          }

          // C3: session token lives exclusively in the HttpOnly cookie —
          // body fallback was a defence-in-depth trap (rotated token never
          // returned in body, so cookieless clients broke on second refresh)
          // and was removed to reduce the log-leak surface (S-M1).
          const refresh_token = readSessionCookie(headers.cookie, cookieConfig);
          if (!refresh_token) {
            set.status = 400;
            return { error: "invalid_request" };
          }
          try {
            const tokens = await run(auth.refreshTokens(refresh_token));
            set.headers["set-cookie"] = buildSessionCookie(tokens.refreshToken, cookieConfig);
            return toTokenResponseCookieOnly(tokens);
          } catch (e) {
            set.status = 400;
            return { error: "invalid_grant", message: String(e) };
          }
        },
        {
          body: t.Object({
            grant_type: t.String(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: begin registration
      //
      // Authenticated via `Authorization: Bearer <access_token>`. S-H1:
      // when the account already has ≥1 passkey, a fresh step-up token
      // (via `X-Step-Up-Token` header or `step_up_token` body field) is
      // REQUIRED — a stolen access token alone cannot bind a new
      // authenticator. First-passkey enrollment (bootstrap) bypasses the
      // gate because no step-up ceremony is reachable before the account
      // has any credentials.
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/begin",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(headers, "passkey_register_begin", rl.passkeyRegisterBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const principal = await resolvePasskeyEnrollPrincipal(
              headers.authorization,
              body.profileId,
            );
            if (principal.unauthorized) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            const result = await run(
              auth.beginPasskeyRegistration(principal.accountId, stepUpToken),
            );
            return result.options;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            profileId: t.String(),
            step_up_token: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: complete registration
      //
      // S-H1: the caller's session token is derived from the HttpOnly
      // cookie — NOT from optional body input — so H1 invalidation (every
      // other session on the account gets revoked) cannot be silently
      // skipped by a malicious caller.
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/complete",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(
            headers,
            "passkey_register_complete",
            rl.passkeyRegisterComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const principal = await resolvePasskeyEnrollPrincipal(
              headers.authorization,
              body.profileId,
            );
            if (principal.unauthorized) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const result = await run(
              auth.completePasskeyRegistration(
                principal.accountId,
                body.attestation,
                cookieToken,
                sessionMetaFrom(headers),
              ),
            );
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            profileId: t.String(),
            attestation: t.Any(),
          }),
        },
      )
      // =========================================================================
      // First-party direct-session login endpoints
      //
      // Passkey (and security key) is the only primary login factor. The
      // `/login/recovery/complete` endpoint lower in this file is the
      // "lost your device" escape hatch — it issues a session directly
      // from a recovery code + identifier. OTP and magic link remain
      // only as step-up and email-change factors, never as a primary
      // login.
      // =========================================================================
      .post(
        "/login/passkey/begin",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(headers, "passkey_login_begin", rl.passkeyLoginBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            // M-PK: identifier is optional. Omitting it kicks off the
            // discoverable-credential / conditional-UI flow and the
            // response carries a `challengeId` the client must round-trip
            // to /login/passkey/complete.
            const result = await run(auth.beginPasskeyLogin(body.identifier ?? null));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.Optional(t.String()) }),
        },
      )
      .post(
        "/login/passkey/complete",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(headers, "passkey_login_complete", rl.passkeyLoginComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          // Exactly one of identifier / challengeId must be present.
          const hasIdentifier = typeof body.identifier === "string" && body.identifier.length > 0;
          const hasChallengeId =
            typeof body.challengeId === "string" && body.challengeId.length > 0;
          if (hasIdentifier === hasChallengeId) {
            set.status = 400;
            return { error: "invalid_request" };
          }
          try {
            const result = await run(
              auth.completePasskeyLoginDirect(
                hasIdentifier
                  ? { identifier: body.identifier!, assertion: body.assertion }
                  : { challengeId: body.challengeId!, assertion: body.assertion },
                sessionMetaFrom(headers),
              ),
            );
            set.headers["set-cookie"] = buildSessionCookie(
              result.session.refreshToken,
              cookieConfig,
            );
            return {
              session: toTokenResponseCookieOnly(result.session),
              profile: result.profile,
            };
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            identifier: t.Optional(t.String()),
            challengeId: t.Optional(t.String()),
            assertion: t.Any(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Profile switching (P2 — multi-account)
      //
      // S-H1: these endpoints authenticate via Bearer access token (not
      // refresh token in body). The access token's `sub` is `profileId`;
      // we resolve `accountId` via DB lookup.
      // -------------------------------------------------------------------------
      .get("/profiles/list", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "profile_list", rl.profileList);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          return await run(auth.listAccountProfiles(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .post(
        "/profiles/switch",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(headers, "profile_switch", rl.profileSwitch);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const result = await run(auth.switchProfile(profile.accountId, body.profile_id));
            return {
              access_token: result.accessToken,
              expires_in: result.expiresIn,
              profile: result.profile,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            profile_id: t.String({ pattern: "^usr_[a-f0-9]{12}$" }),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Recovery codes (Copenhagen Book M2)
      //
      // POST /recovery/generate  — authenticated. Returns a fresh set of 10
      //                            single-use recovery codes as plaintext once.
      //                            Replaces any existing set. Tight rate limit.
      //
      // POST /login/recovery/complete — unauthenticated. Exchanges an identifier
      //                            + recovery code for a full session + profile,
      //                            and revokes all other sessions for the account.
      // -------------------------------------------------------------------------
      .post(
        "/recovery/generate",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(headers, "recovery_generate", rl.recoveryGenerate);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            // M-PK1: require a fresh step-up token (passkey or OTP amr by
            // default). Access token alone is insufficient — a stolen
            // access token cannot burn the user's existing recovery codes.
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            await run(auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken));
            const result = await run(
              auth.generateRecoveryCodesForAccount(profile.accountId, sessionMetaFrom(headers)),
            );
            // S-L2: wire field is `recoveryCodes` (not `codes`) so the
            // redaction deny-list entry actually matches in logs.
            return { recoveryCodes: result.recoveryCodes };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            step_up_token: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/login/recovery/complete",
        async ({ body, set, headers }) => {
          const rlErr = await rateLimit(headers, "recovery_complete", rl.recoveryComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.completeRecoveryLogin(body.identifier, body.code, sessionMetaFrom(headers)),
            );
            set.headers["set-cookie"] = buildSessionCookie(
              result.session.refreshToken,
              cookieConfig,
            );
            return {
              session: toTokenResponseCookieOnly(result.session),
              profile: result.profile,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ identifier: t.String(), code: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Logout (server-side session destruction — Copenhagen Book C1 / C3)
      //
      // Cookie-only. The refresh-token-in-body fallback was removed: no
      // first-party flow sends a refresh token in the body any more, and
      // accepting it here kept the server one accidental-logging incident
      // away from a credential leak. Idempotent — always returns 200.
      // -------------------------------------------------------------------------
      .post("/logout", async ({ set, headers }) => {
        const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
        if (cookieToken) {
          try {
            await run(auth.invalidateSession(cookieToken));
          } catch {
            // Swallow — don't leak whether the session existed.
          }
        }
        set.headers["set-cookie"] = buildClearSessionCookie(cookieConfig);
        return { success: true };
      })
      // -------------------------------------------------------------------------
      // Step-up (sudo) — passkey + OTP ceremonies that mint a short-lived
      // JWT required for sensitive operations (recovery generate, email
      // change). All routes authenticate via Bearer access token so the
      // account is known up-front; the challenge / OTP stores are keyed
      // by accountId to keep the ceremony scoped to the caller.
      // -------------------------------------------------------------------------
      .post("/step-up/passkey/begin", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "step_up_passkey_begin", rl.stepUpPasskeyBegin);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          return await run(auth.beginStepUpPasskey(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .post(
        "/step-up/passkey/complete",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(
            headers,
            "step_up_passkey_complete",
            rl.stepUpPasskeyComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const result = await run(auth.completeStepUpPasskey(profile.accountId, body.assertion));
            return {
              step_up_token: result.stepUpToken,
              expires_in: result.expiresIn,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ assertion: t.Any() }),
        },
      )
      .post("/step-up/otp/begin", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "step_up_otp_begin", rl.stepUpOtpBegin);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          return await run(auth.beginStepUpOtp(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .post(
        "/step-up/otp/complete",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(headers, "step_up_otp_complete", rl.stepUpOtpComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const result = await run(auth.completeStepUpOtp(profile.accountId, body.code));
            return {
              step_up_token: result.stepUpToken,
              expires_in: result.expiresIn,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ code: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Session introspection + revocation
      //
      // `GET /sessions` lists the caller's active sessions for the account,
      // marking the one currently attached to the request cookie as
      // "isCurrent". `DELETE /sessions/:id` revokes a single session by
      // its public handle (first 16 hex of the SHA-256 hash).
      // `POST /sessions/revoke-all-other` is the "sign out everywhere else"
      // button — it preserves the caller's current session.
      // -------------------------------------------------------------------------
      .get("/sessions", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "session_list", rl.sessionList);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
          const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
          return await run(auth.listAccountSessions(profile.accountId, currentHash));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .delete(
        "/sessions/:id",
        async ({ params, headers, set }) => {
          const rlErr = await rateLimit(headers, "session_revoke", rl.sessionRevoke);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            const result = await run(
              auth.revokeAccountSession(profile.accountId, params.id, currentHash),
            );
            if (result.revokedSelf) {
              set.headers["set-cookie"] = buildClearSessionCookie(cookieConfig);
            }
            return { success: true, revokedSelf: result.revokedSelf };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^[0-9a-f]{16}$" }) }),
        },
      )
      .post("/sessions/revoke-all-other", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "session_revoke", rl.sessionRevoke);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
          if (!cookieToken) {
            set.status = 400;
            return { error: "invalid_request", message: "No current session" };
          }
          const currentHash = auth.hashSessionToken(cookieToken);
          await run(auth.revokeAllOtherAccountSessions(profile.accountId, currentHash));
          return { success: true };
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      // -------------------------------------------------------------------------
      // Email change (step-up gated)
      //
      // `POST /account/email/begin` sends an OTP to the NEW email address.
      // `POST /account/email/complete` swaps the account's email on a matching
      //   OTP + a valid step-up token (passkey or OTP amr). All other sessions
      //   are revoked atomically in the same transaction as the email update.
      // -------------------------------------------------------------------------
      .post(
        "/account/email/begin",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(headers, "email_change_begin", rl.emailChangeBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            return await run(auth.beginEmailChange(profile.accountId, body.new_email));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ new_email: t.String() }),
        },
      )
      .post(
        "/account/email/complete",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(headers, "email_change_complete", rl.emailChangeComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            const result = await run(
              auth.completeEmailChange(
                profile.accountId,
                body.code,
                body.step_up_token,
                currentHash,
              ),
            );
            return { email: result.email };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            code: t.String(),
            step_up_token: t.String(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Security events (M-PK1b)
      //
      // `GET /account/security-events` lists the caller's still-unacknowledged
      // security events so the Settings banner can surface "was this you?"
      // prompts without relying on the confirmation email reaching the inbox.
      // `POST /account/security-events/:id/ack` dismisses the banner for a
      // single event and is idempotent on missing / already-acked IDs.
      // -------------------------------------------------------------------------
      .get("/account/security-events", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "security_event_list", rl.securityEventList);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          return await run(auth.listUnacknowledgedSecurityEvents(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .post(
        "/account/security-events/:id/ack",
        async ({ params, body, headers, set }) => {
          const rlErr = await rateLimit(headers, "security_event_ack", rl.securityEventAck);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            // S-M1: step-up gate. Access token alone is insufficient — an
            // XSS-captured token must not be able to silently dismiss the
            // banner that exists precisely to notice that compromise.
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            const result = await run(
              auth.acknowledgeSecurityEvent(profile.accountId, params.id, stepUpToken),
            );
            return { acknowledged: result.acknowledged };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^sev_[a-f0-9]{12}$" }) }),
          body: t.Object({ step_up_token: t.Optional(t.String()) }),
        },
      )
      .post(
        "/account/security-events/ack-all",
        async ({ body, headers, set }) => {
          const rlErr = await rateLimit(headers, "security_event_ack", rl.securityEventAck);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            const result = await run(
              auth.acknowledgeAllSecurityEvents(profile.accountId, stepUpToken),
            );
            return { acknowledged: result.acknowledged };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ step_up_token: t.Optional(t.String()) }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey management (M-PK)
      //
      // GET    /passkeys       — list the caller's credentials (public shape)
      // PATCH  /passkeys/:id   — rename (label only; step-up NOT required)
      // DELETE /passkeys/:id   — remove, revokes other sessions, requires
      //                          step-up (passkey or OTP amr) so an XSS that
      //                          captured an access token cannot drop the
      //                          account's real authenticators.
      // -------------------------------------------------------------------------
      .get("/passkeys", async ({ headers, set }) => {
        const rlErr = await rateLimit(headers, "passkey_list", rl.passkeyList);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          return await run(auth.listPasskeys(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .patch(
        "/passkeys/:id",
        async ({ params, body, headers, set }) => {
          const rlErr = await rateLimit(headers, "passkey_rename", rl.passkeyRename);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            // S-M2: rename is gated by step-up too. Otherwise an XSS-captured
            // access token could swap labels to mislead the user about which
            // credential they're confirming a delete on. Same AMR set as
            // delete (defaults to passkey-only via passkeyDeleteAllowedAmr).
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            await run(auth.verifyStepUpForPasskeyDelete(profile.accountId, stepUpToken));
            await run(auth.renamePasskey(profile.accountId, params.id, body.label));
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^pk_[a-f0-9]{12}$" }) }),
          body: t.Object({ label: t.String(), step_up_token: t.Optional(t.String()) }),
        },
      )
      .delete(
        "/passkeys/:id",
        async ({ params, body, headers, set }) => {
          const rlErr = await rateLimit(headers, "passkey_delete", rl.passkeyDelete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body?.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            // S-L4: passkey-delete uses its own AMR set (defaults to
            // passkey-only). The caller necessarily has a passkey by
            // construction (last-passkey guard), so requiring one for
            // deletion is the strongest available signal.
            await run(auth.verifyStepUpForPasskeyDelete(profile.accountId, stepUpToken));
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            const result = await run(
              auth.deletePasskey(
                profile.accountId,
                params.id,
                currentHash,
                sessionMetaFrom(headers),
              ),
            );
            return { success: true, remaining: result.remaining };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^pk_[a-f0-9]{12}$" }) }),
          body: t.Optional(t.Object({ step_up_token: t.Optional(t.String()) })),
        },
      )
      // -------------------------------------------------------------------------
      // Cross-device login (QR-code mediated session transfer)
      //
      // `POST /login/cross-device/begin` — unauthenticated. Creates a pending
      //   request and returns { requestId, secret, expiresAt }.
      //
      // `POST /login/cross-device/:requestId/status` — unauthenticated. Polls
      //   for approval. Returns session tokens exactly once on approved.
      //
      // `POST /login/cross-device/:requestId/approve` — authenticated. Device A
      //   approves the request; server issues a session for device B.
      //
      // `POST /login/cross-device/:requestId/reject` — authenticated. Device A
      //   explicitly rejects the request.
      // -------------------------------------------------------------------------
      .post("/login/cross-device/begin", async ({ set, headers }) => {
        const rlErr = await rateLimit(headers, "cross_device_begin", rl.crossDeviceBegin);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const result = await run(auth.beginCrossDeviceLogin(sessionMetaFrom(headers)));
          return result;
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .post(
        "/login/cross-device/:requestId/status",
        async ({ params, body, set, headers }) => {
          const rlErr = await rateLimit(headers, "cross_device_poll", rl.crossDevicePoll);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(auth.getCrossDeviceLoginStatus(params.requestId, body.secret));
            if (result.status === "approved") {
              set.headers["set-cookie"] = buildSessionCookie(
                result.session.refreshToken,
                cookieConfig,
              );
              return {
                status: result.status,
                session: toTokenResponseCookieOnly(result.session),
                profile: result.profile,
              };
            }
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ requestId: t.String({ pattern: "^cdl_[a-f0-9]{12}$" }) }),
          body: t.Object({ secret: t.String() }),
        },
      )
      .post(
        "/login/cross-device/:requestId/approve",
        async ({ params, body, set, headers }) => {
          const rlErr = await rateLimit(headers, "cross_device_approve", rl.crossDeviceApprove);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            await run(
              auth.approveCrossDeviceLogin(
                params.requestId,
                body.secret,
                profile.accountId,
                sessionMetaFrom(headers),
              ),
            );
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ requestId: t.String({ pattern: "^cdl_[a-f0-9]{12}$" }) }),
          body: t.Object({ secret: t.String() }),
        },
      )
      .post(
        "/login/cross-device/:requestId/reject",
        async ({ params, body, set, headers }) => {
          const rlErr = await rateLimit(headers, "cross_device_reject", rl.crossDeviceReject);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            await run(auth.rejectCrossDeviceLogin(params.requestId, body.secret));
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ requestId: t.String({ pattern: "^cdl_[a-f0-9]{12}$" }) }),
          body: t.Object({ secret: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // OIDC discovery (minimal)
      // -------------------------------------------------------------------------
      .get("/.well-known/openid-configuration", () => ({
        issuer: authConfig.issuerUrl,
        token_endpoint: `${authConfig.issuerUrl}/token`,
        jwks_uri: `${authConfig.issuerUrl}/.well-known/jwks.json`,
        grant_types_supported: ["refresh_token"],
        scopes_supported: ["openid", "profile", "email"],
        id_token_signing_alg_values_supported: ["ES256"],
      }))
      .get("/.well-known/jwks.json", ({ set }) => {
        // S-H1: explicit caching contract — aligns with pulse-side JWKS_CACHE_TTL_MS (5 min).
        set.headers["cache-control"] = "public, max-age=300, stale-while-revalidate=60";
        metricAuthJwksServed();
        return jwksResponse;
      })
  );
}
