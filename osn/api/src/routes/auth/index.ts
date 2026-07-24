/**
 * Auth routes — composition root.
 *
 * `createAuthRoutes` keeps its original signature; it builds a shared
 * {@link AuthRouteContext} (auth service, app runner, rate-limit /
 * Turnstile gates, cookie + IP plumbing) once, then mounts one Elysia
 * route group per auth domain. Everything previously importable from
 * `routes/auth` is re-exported below, so external import paths are
 * unchanged.
 */

import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import type { ClientIpOptions } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Layer } from "effect";
import { Elysia } from "elysia";

import type { CookieSessionConfig } from "../../lib/cookie-session";
import type { AppRuntime } from "../../lib/route-runtime";
import type { AuthConfig } from "../../services/auth";
import { createAuthRouteContext } from "./context";
import { createCrossDeviceRoutes } from "./cross-device";
import { createEmailChangeRoutes } from "./email-change";
import { createDefaultAuthRateLimiters, type AuthRateLimiters } from "./limiters";
import { createPasskeyLoginRoutes } from "./login";
import { createOidcRoutes } from "./oidc";
import { createOidcClientRoutes } from "./oidc-clients";
import { createPasskeyEnrollRoutes } from "./passkey-enroll";
import { createPasskeyManagementRoutes } from "./passkey-management";
import { createProfileSwitchRoutes } from "./profile-switch";
import { createRecoveryRoutes } from "./recovery";
import { createRegistrationRoutes } from "./registration";
import { createSecurityEventRoutes } from "./security-events";
import { createSessionRoutes } from "./sessions";
import { createStepUpRoutes } from "./step-up";
import { createTokenRoutes } from "./tokens";
import { createWellKnownRoutes } from "./well-known";

export { createDefaultAuthRateLimiters, type AuthRateLimiters } from "./limiters";

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
  /**
   * Client-IP trust policy (S-M34). Controls how the request's keying IP is
   * derived from headers + socket peer for rate limiting and session-IP
   * persistence. The composition root (`osn/api/src/index.ts`) builds this
   * from `TRUSTED_PROXY_COUNT` (and would set `trustCloudflare` behind CF).
   *
   * Defaults to `{}` — i.e. direct mode with no trusted proxy. In direct
   * mode the keying IP comes solely from the transport socket peer
   * (`socketIp`, wired per-request from Bun's `server.requestIP`), never from
   * a spoofable `x-forwarded-for`. Tests that exercise per-IP buckets via an
   * `x-forwarded-for` header pass `{ trustedProxyCount: 1 }` here.
   */
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
  /**
   * Shared application runtime (built once in `index.ts`). When provided, all
   * handlers run against it so the observability SDK + DB connection are
   * reused process-wide instead of being rebuilt per request. When omitted
   * (tests), a runtime is built once from `dbLayer` + `loggerLayer`.
   */
  runtime?: AppRuntime,
  /**
   * Cloudflare Turnstile verifier (bot protection). KEY-OPTIONAL:
   *
   *  - `null` / omitted ⇒ Turnstile is NOT configured (the `TURNSTILE_SECRET_KEY`
   *    secret is unset). The credential-abuse gates below are skipped entirely
   *    and the register / passkey-login flows behave exactly as before — this is
   *    what makes the feature safe to ship before the widget is created.
   *  - a verifier ⇒ Turnstile IS configured. `/register/begin` and
   *    `/login/passkey/begin` REQUIRE a valid `turnstileToken` in the body and
   *    fail CLOSED (400 `turnstile_failed`) on a missing/invalid/duplicate
   *    token. Tokens are single-use (Cloudflare enforces); the secret never
   *    leaves the server.
   */
  turnstileVerifier: TurnstileVerifier | null = null,
) {
  const ctx = createAuthRouteContext({
    authConfig,
    dbLayer,
    loggerLayer,
    rateLimiters,
    cookieConfig,
    clientIpConfig,
    runtime,
    turnstileVerifier,
  });

  return new Elysia({ prefix: "" })
    .use(createRegistrationRoutes(ctx))
    .use(createTokenRoutes(ctx))
    .use(createPasskeyEnrollRoutes(ctx))
    .use(createPasskeyLoginRoutes(ctx))
    .use(createProfileSwitchRoutes(ctx))
    .use(createRecoveryRoutes(ctx))
    .use(createStepUpRoutes(ctx))
    .use(createSessionRoutes(ctx))
    .use(createEmailChangeRoutes(ctx))
    .use(createSecurityEventRoutes(ctx))
    .use(createPasskeyManagementRoutes(ctx))
    .use(createCrossDeviceRoutes(ctx))
    .use(createOidcRoutes(ctx))
    .use(createOidcClientRoutes(ctx))
    .use(createWellKnownRoutes(ctx));
}
