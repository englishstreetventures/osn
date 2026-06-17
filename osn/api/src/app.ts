import { cors } from "@elysiajs/cors";
import { DbLive } from "@osn/db/service";
import { healthRoutes, observabilityPlugin } from "@shared/observability";
import type { ClientIpOptions } from "@shared/rate-limit";
import { Elysia } from "elysia";

import type { CookieSessionConfig } from "./lib/cookie-session";
import { createOriginGuard } from "./lib/origin-guard";
import type { RedisCeremonyWiring } from "./lib/redis-ceremony-stores";
import type {
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
  createRedisOrgRateLimiter,
  createRedisProfileRateLimiters,
  createRedisRecommendationRateLimiter,
} from "./lib/redis-rate-limiters";
import type { createRedisRotatedSessionStore } from "./lib/rotated-session-store";
import type { createRedisJtiStore } from "./lib/step-up-jti-store";
import { createAccountErasureRoutes } from "./routes/account-erasure";
import { createAuthRoutes } from "./routes/auth";
import { createGraphRoutes } from "./routes/graph";
import { createInternalGraphRoutes } from "./routes/graph-internal";
import { createInternalAccountRoutes } from "./routes/internal-account";
import { createOrganisationRoutes } from "./routes/organisation";
import { createInternalOrganisationRoutes } from "./routes/organisation-internal";
import { createProfileRoutes } from "./routes/profile";
import { createRecommendationRoutes } from "./routes/recommendations";
import type { AuthConfig } from "./services/auth";

/**
 * Everything the Elysia composition below references. Built once at boot (Bun
 * dev entry / future Workers entry) and handed to `createApp` verbatim — the
 * factory itself never touches `process.env`, so it composes identically on
 * any runtime. The Effect layer graph (`appRuntime`) is shared, never rebuilt
 * per request (CLAUDE.md > Effect runtime).
 */
export interface AppDeps {
  /** Service name threaded through observability + health routes. */
  serviceName: string;
  /** Auth config (rp id/name, origins, issuer, JWT key material, TTLs, pepper). */
  authConfig: AuthConfig;
  /** Cookie session config — drives Secure flag + `__Host-` prefix. */
  cookieConfig: CookieSessionConfig;
  /** Resolved + validated CORS allowlist. */
  corsOrigins: string[];
  /** Origin-header guard derived from `corsOrigins`. */
  originGuard: ReturnType<typeof createOriginGuard>;
  /** DB + email Effect layer (used directly by auth + account-erasure). */
  dbAndEmailLayer: Parameters<typeof createAuthRoutes>[1];
  /** Observability Effect layer (logger/tracing/metrics). */
  observabilityLayer: Parameters<typeof createAuthRoutes>[2];
  /** Shared `ManagedRuntime` — the layer graph, built once. */
  appRuntime: Parameters<typeof createAuthRoutes>[6];
  /** Per-IP auth rate limiters. */
  authRateLimiters: ReturnType<typeof createRedisAuthRateLimiters>;
  /** Per-user graph write rate limiter. */
  graphRateLimiter: ReturnType<typeof createRedisGraphRateLimiter>;
  /** Per-user org write rate limiter. */
  orgRateLimiter: ReturnType<typeof createRedisOrgRateLimiter>;
  /** Per-user profile rate limiters. */
  profileRateLimiters: ReturnType<typeof createRedisProfileRateLimiters>;
  /** Per-user recommendation rate limiter. */
  recommendationRateLimiter: ReturnType<typeof createRedisRecommendationRateLimiter>;
  /** Cluster-safe single-use guard for step-up JWTs. */
  stepUpJtiStore: ReturnType<typeof createRedisJtiStore>;
  /** Cluster-safe rotated-session reuse-detection store. */
  rotatedSessionStore: ReturnType<typeof createRedisRotatedSessionStore>;
  /**
   * O3/O2 (W6) — Redis-backed ceremony / pending-state stores, the recovery-code
   * lockout counter, and the two per-account caps. Spread into `authConfig` at
   * the `createAuthRoutes` call alongside the step-up / rotated-session stores.
   */
  ceremonyStores: RedisCeremonyWiring["ceremonyStores"];
  recoveryLockoutStore: RedisCeremonyWiring["recoveryLockoutStore"];
  profileSwitchCap: RedisCeremonyWiring["profileSwitchCap"];
  emailChangeBeginCap: RedisCeremonyWiring["emailChangeBeginCap"];
  /**
   * Client-IP trust policy (S-M34). Derived from `TRUSTED_PROXY_COUNT`. Threaded
   * into the auth + profile route factories so per-IP rate-limit keying + the
   * session-IP hash are spoofing-safe behind a known proxy topology.
   */
  clientIpConfig: Omit<ClientIpOptions, "socketIp">;
}

/**
 * Pure application factory. Composes the Elysia app from pre-built dependencies
 * — knows nothing about `process.env`, the runtime, or how `deps` were built.
 * The composition is identical to the previous module-top-level block in
 * `index.ts`; only the env-driven wiring moved out (to `local.ts`).
 */
export function createApp(deps: AppDeps) {
  const {
    serviceName,
    authConfig,
    cookieConfig,
    corsOrigins,
    originGuard,
    dbAndEmailLayer,
    observabilityLayer,
    appRuntime,
    authRateLimiters,
    graphRateLimiter,
    orgRateLimiter,
    profileRateLimiters,
    recommendationRateLimiter,
    stepUpJtiStore,
    rotatedSessionStore,
    ceremonyStores,
    recoveryLockoutStore,
    profileSwitchCap,
    emailChangeBeginCap,
    clientIpConfig,
  } = deps;

  return new Elysia()
    .use(cors({ origin: corsOrigins, credentials: true }))
    .onBeforeHandle(originGuard)
    .use(observabilityPlugin({ serviceName }))
    .use(healthRoutes({ serviceName }))
    .get("/", () => ({ status: "ok", service: "osn-auth" }))
    .use(
      createAuthRoutes(
        // INTEGRATION: O3/O2 (W6) — ceremonyStores + recoveryLockoutStore + the
        // two caps join stepUpJtiStore / rotatedSessionStore on the auth config.
        {
          ...authConfig,
          stepUpJtiStore,
          rotatedSessionStore,
          ceremonyStores,
          recoveryLockoutStore,
          profileSwitchCap,
          emailChangeBeginCap,
        },
        dbAndEmailLayer,
        observabilityLayer,
        authRateLimiters,
        cookieConfig,
        clientIpConfig,
        appRuntime,
      ),
    )
    .use(createGraphRoutes(authConfig, DbLive, observabilityLayer, graphRateLimiter, appRuntime))
    .use(createInternalGraphRoutes(DbLive, appRuntime))
    .use(
      createOrganisationRoutes(authConfig, DbLive, observabilityLayer, orgRateLimiter, appRuntime),
    )
    .use(createInternalOrganisationRoutes(DbLive, appRuntime))
    .use(
      createProfileRoutes(
        authConfig,
        DbLive,
        observabilityLayer,
        profileRateLimiters,
        clientIpConfig,
        appRuntime,
      ),
    )
    .use(
      createRecommendationRoutes(
        authConfig,
        DbLive,
        observabilityLayer,
        recommendationRateLimiter,
        appRuntime,
      ),
    )
    .use(
      createAccountErasureRoutes(
        authConfig,
        dbAndEmailLayer,
        observabilityLayer,
        undefined,
        cookieConfig,
        appRuntime,
      ),
    )
    .use(createInternalAccountRoutes(authConfig, DbLive, appRuntime));
}

export type App = ReturnType<typeof createApp>;
