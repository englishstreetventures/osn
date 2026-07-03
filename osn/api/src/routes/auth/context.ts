/**
 * Shared per-request plumbing for the auth route groups: the auth service
 * instance, the app runner, IP resolution + rate-limit / Turnstile gates,
 * session-meta extraction, and the prebuilt JWKS document. Built once by
 * `createAuthRoutes` and passed to every route-group factory.
 */

import type { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import type { AuthRateLimitedEndpoint } from "@shared/observability/metrics";
import {
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Layer } from "effect";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import type { CookieSessionConfig } from "../../lib/cookie-session";
import { publicError } from "../../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../../lib/route-runtime";
import { deriveUaLabel } from "../../lib/ua-label";
import { metricAuthRateLimited, metricAuthTurnstileRejected } from "../../metrics";
import { createAuthService, type AuthConfig } from "../../services/auth";
import type { AuthRateLimiters } from "./limiters";

/**
 * Convert a TokenSet to wire format WITHOUT the refresh token (S-M2).
 * Used for first-party flows where the refresh token is in the HttpOnly cookie.
 * Omitting it from the body prevents XSS exfiltration of the session token.
 */
export function toTokenResponseCookieOnly(ts: { accessToken: string; expiresIn: number }) {
  return {
    access_token: ts.accessToken,
    token_type: "Bearer" as const,
    expires_in: ts.expiresIn,
    scope: "openid profile",
  };
}

/** The `createAuthRoutes` parameters, bundled — see `index.ts` for per-field docs. */
export interface AuthRouteDeps {
  authConfig: AuthConfig;
  dbLayer: Layer.Layer<Db | EmailService>;
  loggerLayer: Layer.Layer<never>;
  rateLimiters: AuthRateLimiters;
  cookieConfig: CookieSessionConfig;
  clientIpConfig: Omit<ClientIpOptions, "socketIp">;
  runtime?: AppRuntime | undefined;
  turnstileVerifier: TurnstileVerifier | null;
}

export function createAuthRouteContext(deps: AuthRouteDeps) {
  const {
    authConfig,
    dbLayer,
    loggerLayer,
    rateLimiters,
    cookieConfig,
    clientIpConfig,
    runtime,
    turnstileVerifier,
  } = deps;

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

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  /**
   * Resolve the request's trusted keying IP under the configured policy
   * (S-M34). `socketIp` is the per-request transport peer (Bun
   * `server.requestIP`); it is only consulted in direct mode. Returns the
   * `UNRESOLVED_IP` sentinel when the IP can't be trusted — callers check
   * `isUnresolvedIp` and deny rather than bucketing everyone together.
   */
  const resolveIp = (headers: Record<string, string | undefined>, socketIp: string | null) =>
    getClientIp(headers, { ...clientIpConfig, socketIp });

  /**
   * Per-request transport socket peer (S-M34), read from Bun's
   * `server.requestIP(request)`. Used by direct-mode IP resolution where
   * there is no trusted proxy. `server` is absent under `app.handle(...)` in
   * tests, so this returns `null` there — tests drive per-IP buckets via an
   * `x-forwarded-for` header + `clientIpConfig.trustedProxyCount` instead.
   */
  type IpCtx = {
    server: { requestIP?: (req: Request) => { address?: string } | null } | null;
    request: Request;
  };
  const socketIpOf = (ctx: IpCtx): string | null =>
    ctx.server?.requestIP?.(ctx.request)?.address ?? null;

  /**
   * Extracts the caller's coarse UA label + client IP from incoming headers
   * so `issueTokens` can persist them onto the new session row. Both fields
   * are best-effort — an unresolved IP just yields `null` downstream.
   */
  const sessionMetaFrom = (
    headers: Record<string, string | undefined>,
    socketIp: string | null,
  ) => ({
    uaLabel: deriveUaLabel(headers["user-agent"]),
    ip: (() => {
      const ip = resolveIp(headers, socketIp);
      return isUnresolvedIp(ip) ? null : ip;
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
    socketIp: string | null,
    endpoint: AuthRateLimitedEndpoint,
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = resolveIp(headers, socketIp);
    // S-M34: an unresolved IP must NOT key the limiter — a shared "unknown"
    // bucket is both a spoofing bypass and a DoS amplifier. Deny outright.
    if (isUnresolvedIp(ip)) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
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
   * Turnstile bot-protection gate (KEY-OPTIONAL, fail-closed). Returns `null`
   * to proceed, or an error sentinel the caller turns into a 400.
   *
   *  - `turnstileVerifier === null` (secret unset) ⇒ ALWAYS returns `null`: the
   *    gate is a no-op, the flow runs as it did before Turnstile existed.
   *  - configured ⇒ the body's `turnstileToken` is siteverified with the
   *    caller's `cf-connecting-ip` as `remoteip`. A missing/invalid/duplicate
   *    token (or an unreachable siteverify) fails CLOSED → `{ error }`. The
   *    secret is never logged; only the bounded outcome metric is emitted.
   */
  async function turnstileGate(
    endpoint: "register_begin" | "passkey_login_begin",
    token: string | undefined,
    headers: Record<string, string | undefined>,
  ): Promise<{ error: string } | null> {
    if (!turnstileVerifier) return null;
    // Prefer Cloudflare's attributed client IP for siteverify's risk scoring.
    // Absent (local dev / non-CF), Cloudflare simply scores without it.
    const remoteip = headers["cf-connecting-ip"] ?? null;
    const result = await turnstileVerifier.verify(token, remoteip);
    if (!result.ok) {
      metricAuthTurnstileRejected(endpoint);
      return { error: "turnstile_failed" };
    }
    return null;
  }

  /**
   * Resolves the authenticated principal for /passkey/register/* calls.
   *
   * Authorization is bound to the ACCESS TOKEN'S OWN `sub` — we verify the
   * Bearer token, then resolve the owning account from the token's profile id
   * (the same pattern `/step-up/passkey/*` uses). The enrolment always lands
   * on the caller's own account.
   *
   * The client-supplied `body.profileId` is NOT a trust input and is NOT
   * required to equal the token's `sub`: it cannot move the enrolment to
   * another account (we never read it to pick the account), and requiring an
   * exact echo produced a spurious 401 whenever the client's notion of the
   * active profile drifted from the token's `sub` — e.g. after a silent token
   * refresh re-issues the access token for the account's default profile while
   * the UI still holds a stale `activeProfileId` (Bug B: organiser "Add
   * passkey" returned 401 unauthorized). New users enroll their first passkey
   * using the token issued by `/register/complete`; existing users add more
   * with a normal session access token.
   */
  type Principal = { unauthorized: true } | { unauthorized: false; accountId: string };
  async function resolvePasskeyEnrollPrincipal(authHeader: string | undefined): Promise<Principal> {
    const claims = await resolveAccessTokenPrincipal(auth, authHeader);
    if (!claims) return { unauthorized: true };
    const profile = await run(auth.findProfileById(claims.profileId));
    if (!profile) return { unauthorized: true };
    return { unauthorized: false, accountId: profile.accountId };
  }

  return {
    authConfig,
    cookieConfig,
    jwksResponse,
    auth,
    run,
    handleError,
    resolveIp,
    socketIpOf,
    sessionMetaFrom,
    rl,
    rateLimit,
    turnstileGate,
    resolvePasskeyEnrollPrincipal,
  };
}

export type AuthRouteContext = ReturnType<typeof createAuthRouteContext>;
