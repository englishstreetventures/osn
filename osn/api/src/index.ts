import { cors } from "@elysiajs/cors";
import { DbLive } from "@osn/db/service";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

import {
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
  createRedisOrgRateLimiter,
  createRedisProfileRateLimiters,
  createRedisRecommendationRateLimiter,
} from "./lib/redis-rate-limiters";
import { initRedisClient } from "./redis";
import { createAuthRoutes } from "./routes/auth";
import { createGraphRoutes } from "./routes/graph";
import { createInternalGraphRoutes } from "./routes/graph-internal";
import { createOrganisationRoutes } from "./routes/organisation";
import { createInternalOrganisationRoutes } from "./routes/organisation-internal";
import { createProfileRoutes } from "./routes/profile";
import { createRecommendationRoutes } from "./routes/recommendations";

const SERVICE_NAME = "osn-api";
const port = Number(process.env.PORT) || 4000;

// S-L2: Fail at startup in production when the JWT signing secret is not set.
if (process.env.NODE_ENV === "production" && !process.env.OSN_JWT_SECRET) {
  throw new Error("OSN_JWT_SECRET must be set in production");
}

// Initialise observability (logger, tracing, metrics) before building the app.
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

const authConfig = {
  rpId: process.env.OSN_RP_ID || "localhost",
  rpName: process.env.OSN_RP_NAME || "OSN",
  origin: process.env.OSN_ORIGIN || "http://localhost:5173",
  issuerUrl: process.env.OSN_ISSUER_URL || `http://localhost:${port}`,
  jwtSecret: process.env.OSN_JWT_SECRET || "dev-secret-change-in-prod",
  accessTokenTtl: Number(process.env.OSN_ACCESS_TOKEN_TTL) || 3600,
  refreshTokenTtl: Number(process.env.OSN_REFRESH_TOKEN_TTL) || 2592000,
};

// ---------------------------------------------------------------------------
// Redis client — env-driven backend selection (S-M2)
//
// See `./redis.ts` for the full initialisation logic (TLS warning, credential
// redaction, REDIS_REQUIRED fail-closed mode, lazyConnect lifecycle).
// ---------------------------------------------------------------------------

const redisClient = await initRedisClient({
  redisUrl: process.env.REDIS_URL,
  redisRequired: process.env.REDIS_REQUIRED === "true",
  nodeEnv: process.env.NODE_ENV,
  loggerLayer: observabilityLayer,
});

const authRateLimiters = createRedisAuthRateLimiters(redisClient);
const graphRateLimiter = createRedisGraphRateLimiter(redisClient);
const orgRateLimiter = createRedisOrgRateLimiter(redisClient);
const profileRateLimiters = createRedisProfileRateLimiters(redisClient);
const recommendationRateLimiter = createRedisRecommendationRateLimiter(redisClient);

// S-L1: Restrict CORS to the known app origin instead of the open wildcard.
// OSN_CORS_ORIGIN may be a comma-separated list for multi-origin setups.
const corsOrigins = process.env.OSN_CORS_ORIGIN
  ? process.env.OSN_CORS_ORIGIN.split(",").map((o) => o.trim())
  : authConfig.origin;

const app = new Elysia()
  .use(cors({ origin: corsOrigins }))
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "osn-auth" }))
  .use(createAuthRoutes(authConfig, DbLive, observabilityLayer, authRateLimiters))
  .use(createGraphRoutes(authConfig, DbLive, observabilityLayer, graphRateLimiter))
  .use(createInternalGraphRoutes(DbLive))
  .use(createOrganisationRoutes(authConfig, DbLive, observabilityLayer, orgRateLimiter))
  .use(createInternalOrganisationRoutes(DbLive))
  .use(createProfileRoutes(authConfig, DbLive, observabilityLayer, profileRateLimiters))
  .use(
    createRecommendationRoutes(authConfig, DbLive, observabilityLayer, recommendationRateLimiter),
  );

if (process.env.NODE_ENV !== "test") {
  app.listen({ port, reusePort: false });
  void Effect.runPromise(
    Effect.logInfo("osn-app listening").pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );
}

export { app };
export type App = typeof app;
