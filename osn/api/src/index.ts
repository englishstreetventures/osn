import { cors } from "@elysiajs/cors";
import { DbLive } from "@osn/db/service";
import { generateArcKeyPair, importKeyFromJwk, thumbprintKid } from "@shared/crypto";
import { makeCloudflareEmailLive, makeLogEmailLive } from "@shared/email";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { sanitizeCause } from "@shared/redis";
import { Effect, Layer, Logger } from "effect";
import { Elysia } from "elysia";

import type { CookieSessionConfig } from "./lib/cookie-session";
import { assertCorsOriginsConfigured, resolveCorsOrigins } from "./lib/cors-config";
import { createOriginGuard } from "./lib/origin-guard";
import {
  createRedisAccountExportRateLimiter,
  createRedisAccountExportStatusRateLimiter,
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
  createRedisOrgRateLimiter,
  createRedisProfileRateLimiters,
  createRedisRecommendationRateLimiter,
} from "./lib/redis-rate-limiters";
import { createRedisRotatedSessionStore } from "./lib/rotated-session-store";
import { createRedisJtiStore } from "./lib/step-up-jti-store";
import { initRedisClient } from "./redis";
import { createAccountExportRoutes } from "./routes/account-export";
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

// S-M2: Session IP pepper is the HMAC key used to turn issuing IPs into
// rainbow-table-resistant hashes on the `sessions.ip_hash` column. Fail
// loudly if it's missing in a non-local deployment — silently dropping
// the hash degrades the Sessions panel's "is this device mine" signal.
const envNonLocal = process.env.OSN_ENV && process.env.OSN_ENV !== "local";
const sessionIpPepper = process.env.OSN_SESSION_IP_PEPPER;
if (envNonLocal && (!sessionIpPepper || sessionIpPepper.length < 32)) {
  throw new Error(
    "OSN_SESSION_IP_PEPPER must be set to at least 32 bytes in non-local environments",
  );
}

const authConfig = {
  rpId: process.env.OSN_RP_ID || "localhost",
  rpName: process.env.OSN_RP_NAME || "OSN",
  origin: process.env.OSN_ORIGIN || "http://localhost:5173",
  issuerUrl: process.env.OSN_ISSUER_URL || `http://localhost:${port}`,
  jwtPrivateKey,
  jwtPublicKey,
  jwtKid,
  jwtPublicKeyJwk,
  // 5 min default — short TTL caps XSS blast radius on the access token.
  // Refresh token is in an HttpOnly cookie (C3) so silent refresh on 401
  // is transparent to the user.
  accessTokenTtl: Number(process.env.OSN_ACCESS_TOKEN_TTL) || 300,
  refreshTokenTtl: Number(process.env.OSN_REFRESH_TOKEN_TTL) || 2592000,
  sessionIpPepper,
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

// S-H1: cluster-safe single-use guard for step-up JWTs. Wired into
// `authConfig` below so verifyStepUpToken consults Redis on every
// check rather than an in-process Map.
const stepUpJtiStore = createRedisJtiStore(redisClient);

// S-H1 (session): cluster-safe record of rotated-out session hashes so
// C2 reuse detection works across pods. Errors are logged via the Effect
// logger layer so a Redis blip surfaces in ops dashboards. S-M1 —
// `sanitizeCause` strips any credentialed URL (redis://user:pass@…) that
// ioredis may embed in connection-level error strings.
const rotatedSessionStore = createRedisRotatedSessionStore(redisClient, {
  onError: (action, cause) => {
    void Effect.runPromise(
      Effect.logWarning("Rotated-session store Redis error").pipe(
        Effect.annotateLogs({ action, error: sanitizeCause(cause) }),
        Effect.provide(observabilityLayer),
      ),
    );
  },
});

const authRateLimiters = createRedisAuthRateLimiters(redisClient);
const graphRateLimiter = createRedisGraphRateLimiter(redisClient);
const orgRateLimiter = createRedisOrgRateLimiter(redisClient);
const profileRateLimiters = createRedisProfileRateLimiters(redisClient);
const recommendationRateLimiter = createRedisRecommendationRateLimiter(redisClient);
const accountExportRateLimiters = {
  accountExport: createRedisAccountExportRateLimiter(redisClient),
  accountExportStatus: createRedisAccountExportStatusRateLimiter(redisClient),
};

// C3: Cookie session config — Secure flag + __Host- prefix in non-local envs.
const cookieConfig: CookieSessionConfig = {
  secure: !!process.env.OSN_ENV && process.env.OSN_ENV !== "local",
};

// ---------------------------------------------------------------------------
// Email transport (@shared/email)
//
// Production/staging: POST directly to Cloudflare's Email Service REST API.
//   - CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN required
//   - OSN_EMAIL_FROM is the verified sender address (e.g. noreply@osn.app)
//
// Local dev / tests: no env vars → LogEmailLive records sends to an
// in-memory ring, so an operator sees `[email:log] template=...` lines
// but no OTP codes end up in logs. Test code reads the recorder
// directly via `makeLogEmailLive()` in its own composition.
// ---------------------------------------------------------------------------

const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const cfEmailToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN;
if (envNonLocal && (!cfAccountId || !cfEmailToken)) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN must be set in non-local environments",
  );
}

const emailLayer =
  cfAccountId && cfEmailToken
    ? makeCloudflareEmailLive({
        accountId: cfAccountId,
        apiToken: cfEmailToken,
        fromAddress: process.env.OSN_EMAIL_FROM,
      })
    : makeLogEmailLive().layer;

const dbAndEmailLayer = Layer.merge(DbLive, emailLayer);

// S-L1: Restrict CORS to the known app origin instead of the open wildcard.
// Derivation + S-L4 fail-closed invariant live in `./lib/cors-config` so they
// can be unit-tested without booting the whole app. `cookieConfig.secure` is
// the single non-local predicate — a deploy that forgets both `OSN_ENV` and
// `OSN_CORS_ORIGIN` still fails closed at `assertCorsOriginsConfigured`.
const corsOrigins = resolveCorsOrigins(process.env, cookieConfig.secure);
assertCorsOriginsConfigured(corsOrigins, cookieConfig.secure);
const originGuard = createOriginGuard({ allowedOrigins: new Set(corsOrigins) });

const app = new Elysia()
  .use(cors({ origin: corsOrigins, credentials: true }))
  .onBeforeHandle(originGuard)
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "osn-auth" }))
  .use(
    createAuthRoutes(
      { ...authConfig, stepUpJtiStore, rotatedSessionStore },
      dbAndEmailLayer,
      observabilityLayer,
      authRateLimiters,
      cookieConfig,
    ),
  )
  .use(createGraphRoutes(authConfig, DbLive, observabilityLayer, graphRateLimiter))
  .use(createInternalGraphRoutes(DbLive))
  .use(createOrganisationRoutes(authConfig, DbLive, observabilityLayer, orgRateLimiter))
  .use(createInternalOrganisationRoutes(DbLive))
  .use(createProfileRoutes(authConfig, DbLive, observabilityLayer, profileRateLimiters))
  .use(
    createRecommendationRoutes(authConfig, DbLive, observabilityLayer, recommendationRateLimiter),
  )
  .use(
    createAccountExportRoutes(
      authConfig,
      dbAndEmailLayer,
      observabilityLayer,
      accountExportRateLimiters,
    ),
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
