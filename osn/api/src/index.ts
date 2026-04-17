import { cors } from "@elysiajs/cors";
import { DbLive } from "@osn/db/service";
import { generateArcKeyPair, importKeyFromJwk, thumbprintKid } from "@shared/crypto";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

import type { CookieSessionConfig } from "./lib/cookie-session";
import { createOriginGuard } from "./lib/origin-guard";
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

// Initialise observability (logger, tracing, metrics) before building the app.
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

// ---------------------------------------------------------------------------
// JWT key pair — ES256 (ECDSA P-256)
//
// In production, OSN_JWT_PRIVATE_KEY and OSN_JWT_PUBLIC_KEY must be set to
// base64-encoded JWK JSON. Generate once with:
//   node -e "const {subtle}=globalThis.crypto; subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(async k=>{const {exportJWK}=await import('jose');console.log('private:',btoa(JSON.stringify(await exportJWK(k.privateKey))));console.log('public:',btoa(JSON.stringify(await exportJWK(k.publicKey))))})"
//
// In local dev without these vars, an ephemeral key pair is generated (tokens
// are invalidated on restart — acceptable for local development).
// ---------------------------------------------------------------------------

async function loadJwtKeyPair() {
  const { exportJWK } = await import("jose");
  const rawPriv = process.env.OSN_JWT_PRIVATE_KEY;
  const rawPub = process.env.OSN_JWT_PUBLIC_KEY;

  // S-H2: use OSN_ENV (the project's canonical env discriminator) rather than
  // NODE_ENV. A staging deploy with NODE_ENV=development would silently fall
  // through to an ephemeral key pair and issue tokens that can't survive restarts.
  const nonLocal = process.env.OSN_ENV && process.env.OSN_ENV !== "local";
  if (nonLocal && (!rawPriv || !rawPub)) {
    throw new Error(
      "OSN_JWT_PRIVATE_KEY and OSN_JWT_PUBLIC_KEY must be set in non-local environments",
    );
  }

  if (rawPriv && rawPub) {
    const privateKey = await importKeyFromJwk(JSON.parse(atob(rawPriv)) as Record<string, unknown>);
    const publicKey = await importKeyFromJwk(JSON.parse(atob(rawPub)) as Record<string, unknown>);
    const kid = await thumbprintKid(publicKey);
    const jwtPublicKeyJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
    return { privateKey, publicKey, kid, jwtPublicKeyJwk };
  }

  // Ephemeral dev pair — warn via Effect logger after observability is ready.
  const { privateKey, publicKey } = await generateArcKeyPair();
  const kid = await thumbprintKid(publicKey);
  const jwtPublicKeyJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  return { privateKey, publicKey, kid, jwtPublicKeyJwk, ephemeral: true };
}

const {
  privateKey: jwtPrivateKey,
  publicKey: jwtPublicKey,
  kid: jwtKid,
  jwtPublicKeyJwk,
  ephemeral: jwtEphemeral,
} = await loadJwtKeyPair();

const authConfig = {
  rpId: process.env.OSN_RP_ID || "localhost",
  rpName: process.env.OSN_RP_NAME || "OSN",
  origin: process.env.OSN_ORIGIN || "http://localhost:5173",
  issuerUrl: process.env.OSN_ISSUER_URL || `http://localhost:${port}`,
  jwtPrivateKey,
  jwtPublicKey,
  jwtKid,
  jwtPublicKeyJwk,
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

// C3: Cookie session config — Secure flag + __Host- prefix in non-local envs.
const cookieConfig: CookieSessionConfig = {
  secure: !!process.env.OSN_ENV && process.env.OSN_ENV !== "local",
};

// M1: Origin guard — validate Origin header on state-changing requests.
// S-L1: warn if allowlist is empty in non-local envs (guard would be disabled).
const corsOriginSet = new Set(Array.isArray(corsOrigins) ? corsOrigins : [corsOrigins]);
if (corsOriginSet.size === 0 && cookieConfig.secure) {
  void Effect.runPromise(
    Effect.logWarning(
      "OSN_CORS_ORIGIN is empty in a non-local environment — Origin guard is disabled. Set OSN_CORS_ORIGIN to enable CSRF protection.",
    ).pipe(Effect.provide(observabilityLayer)),
  );
}
const originGuard = createOriginGuard({ allowedOrigins: corsOriginSet });

const app = new Elysia()
  .use(cors({ origin: corsOrigins, credentials: true }))
  .onBeforeHandle(originGuard)
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "osn-auth" }))
  .use(createAuthRoutes(authConfig, DbLive, observabilityLayer, authRateLimiters, cookieConfig))
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
    Effect.gen(function* () {
      if (jwtEphemeral) {
        yield* Effect.logWarning(
          "Using ephemeral JWT key pair — tokens will be invalidated on restart. Set OSN_JWT_PRIVATE_KEY and OSN_JWT_PUBLIC_KEY for persistent keys.",
        );
      }
      yield* Effect.logInfo("osn-app listening");
    }).pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );
}

export { app };
export type App = typeof app;
