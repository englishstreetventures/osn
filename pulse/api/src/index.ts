import { cors } from "@elysiajs/cors";
import { DbLive } from "@pulse/db/service";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

import { assertCorsOriginsConfigured, resolveCorsOrigins } from "./lib/cors-config";
import { DEFAULT_JWKS_URL } from "./lib/jwks";
import {
  createRedisDiscoveryRateLimiter,
  createRedisWriteRateLimiters,
} from "./lib/redis-rate-limiters";
import { initRedisClient } from "./redis";
import { createCloseFriendsRoutes } from "./routes/closeFriends";
import { createEventsRoutes, createSettingsRoutes } from "./routes/events";
import { createOnboardingRoutes } from "./routes/onboarding";
import { createSeriesRoutes } from "./routes/series";
import { createVenuesRoutes } from "./routes/venues";
import { startKeyRotation } from "./services/graphBridge";

// Initialise observability (logger, tracing, metrics) before building the app.
// No-op in test runs — tests never call listen() so the layer is never provided.
const SERVICE_NAME = "pulse-api";
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

// ---------------------------------------------------------------------------
// Redis composition root — env-driven backend selection (mirrors osn/api).
//
// `REDIS_URL` set → Redis-backed limiters (shared across processes, survives
// restarts). Unset → in-memory fallback. The route factories accept injected
// `RateLimiterBackend`s, so the only thing that changes between local and
// production is the backing store, never the policy / call sites.
// ---------------------------------------------------------------------------

const nonLocalEnv = !!process.env.OSN_ENV && process.env.OSN_ENV !== "local";

const redisClient = await initRedisClient({
  redisUrl: process.env.REDIS_URL,
  redisRequired: process.env.REDIS_REQUIRED === "true",
  nodeEnv: process.env.NODE_ENV,
  loggerLayer: observabilityLayer,
});

// When REDIS_URL is unset, `initRedisClient` returns an in-memory client and
// the Redis-backed factories degrade to process-local counters — identical
// semantics to the route-factory in-memory defaults, so we can wire the same
// path in both cases and keep one code branch.
const writeRateLimiters = createRedisWriteRateLimiters(redisClient);
const discoveryRateLimiter: RateLimiterBackend = createRedisDiscoveryRateLimiter(redisClient);

const jwksUrl = process.env.OSN_JWKS_URL ?? DEFAULT_JWKS_URL;

// ---------------------------------------------------------------------------
// CORS allowlist — replaces the bare `cors()` wildcard.
//
// Pulse is a bearer-token API (no cookie-CSRF surface, hence no Origin guard),
// but a wildcard ACAO still lets any site read responses from a victim's
// session. Pin to the configured app origin(s); fail closed in non-local envs
// where `PULSE_CORS_ORIGIN` is unset. Local dev falls back to the Tauri port.
// ---------------------------------------------------------------------------

const corsOrigins = resolveCorsOrigins(process.env, nonLocalEnv);
assertCorsOriginsConfigured(corsOrigins, nonLocalEnv);

const app = new Elysia()
  .use(cors({ origin: corsOrigins, credentials: true }))
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "osn-api" }))
  .use(
    createEventsRoutes(DbLive, jwksUrl, undefined, discoveryRateLimiter, {
      eventCreate: writeRateLimiters.event_create,
      eventUpdate: writeRateLimiters.event_update,
      rsvpUpsert: writeRateLimiters.rsvp_upsert,
      eventInvite: writeRateLimiters.event_invite,
      commsBlast: writeRateLimiters.comms_blast,
    }),
  )
  .use(
    createSeriesRoutes(DbLive, jwksUrl, undefined, {
      seriesCreate: writeRateLimiters.series_create,
      seriesUpdate: writeRateLimiters.series_update,
    }),
  )
  .use(createVenuesRoutes())
  .use(createSettingsRoutes(DbLive, jwksUrl))
  .use(createCloseFriendsRoutes(DbLive, jwksUrl, undefined, writeRateLimiters.close_friend_mutate))
  .use(createOnboardingRoutes(DbLive, jwksUrl));

const port = process.env.PORT || 3001;

if (process.env.NODE_ENV !== "test") {
  // S-H3: fetching public keys over plaintext HTTP in a deployed env allows
  // any process with network access to serve a forged JWK set. Fail fast.
  if (nonLocalEnv && jwksUrl.startsWith("http://")) {
    throw new Error("OSN_JWKS_URL must use HTTPS in non-local environments");
  }

  app.listen({ port, reusePort: false });

  // Register our ephemeral public key with osn/api and schedule automatic
  // rotation. Exits the process only on unrecoverable errors (missing
  // secret in non-local, HTTP 4xx/5xx, etc). In local dev, a missing
  // secret or an unreachable osn/api logs a warning and lets the server
  // boot — the latter schedules a background retry so `bun run dev:pulse`
  // is resilient to turbo starting both services in parallel.
  void startKeyRotation()
    .then((status) => {
      if (status === "registered") return;
      const warning =
        status === "skipped-secret-unset"
          ? "pulse-api: ARC key registration skipped — INTERNAL_SERVICE_SECRET is unset. " +
            "S2S calls to osn/api will fail until you set INTERNAL_SERVICE_SECRET in pulse/api/.env " +
            "(matching the value in osn/api/.env)."
          : "pulse-api: osn/api is not reachable yet — retrying ARC key registration in the background. " +
            "This is expected when pulse-api starts before osn/api (e.g. under `bun run dev:pulse`).";
      return Effect.runPromise(
        Effect.logWarning(warning).pipe(
          Effect.annotateLogs({ service: SERVICE_NAME }),
          Effect.provide(Logger.pretty),
          Effect.provide(observabilityLayer),
        ),
      ).catch(() => undefined);
    })
    .catch((err: unknown) => {
      void Effect.runPromise(
        Effect.logError("pulse-api: failed to start ARC key rotation", err).pipe(
          Effect.annotateLogs({ service: SERVICE_NAME }),
          Effect.provide(Logger.pretty),
          Effect.provide(observabilityLayer),
        ),
      )
        .catch(() => {})
        .finally(() => process.exit(1));
    });

  // One structured info log at boot, routed through the observability layer
  // so it picks up resource attributes + redaction. Using Effect.runPromise
  // because the layer is Effect-scoped.
  void Effect.runPromise(
    Effect.logInfo("pulse-api listening").pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );
}

export { app };
export type App = typeof app;
