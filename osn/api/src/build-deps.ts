import type { Db } from "@osn/db/service";
import { generateArcKeyPair, importKeyFromJwk, thumbprintKid } from "@shared/crypto";
import type { EmailService } from "@shared/email";
import type { RedisClient } from "@shared/redis";
import { sanitizeCause } from "@shared/redis";
import { createTurnstileVerifier } from "@shared/turnstile";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { AppDeps } from "./app";
import type { CookieSessionConfig } from "./lib/cookie-session";
import { assertCorsOriginsConfigured, resolveCorsOrigins } from "./lib/cors-config";
import { type OsnRateLimitBindings, selectAuthRateLimiters } from "./lib/native-rate-limiters";
import { createOriginGuard } from "./lib/origin-guard";
import { createRedisCeremonyStores } from "./lib/redis-ceremony-stores";
import {
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
  createRedisOrgRateLimiter,
  createRedisProfileRateLimiters,
  createRedisRecommendationRateLimiter,
} from "./lib/redis-rate-limiters";
import { createRedisRotatedSessionStore } from "./lib/rotated-session-store";
import { createRedisJtiStore } from "./lib/step-up-jti-store";

export const SERVICE_NAME = "osn-api";

/**
 * Loose key/value view of every secret + var this composition root reads.
 *
 * Both entries supply one of these: the Bun dev path passes `process.env`; the
 * Cloudflare Workers `fetch`/`scheduled` handlers pass the request-scoped `env`
 * binding (workerd surfaces wrangler `[vars]` + `wrangler secret put` values
 * here — and secrets are reliably ONLY on `env`, never on `process.env`). The
 * factory never reaches for `process.env` itself, so it composes identically on
 * either runtime.
 */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

const isNonLocal = (env: EnvRecord): boolean => !!env.OSN_ENV && env.OSN_ENV !== "local";

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

export async function loadJwtKeyPair(env: EnvRecord) {
  const { exportJWK } = await import("jose");
  const rawPriv = env.OSN_JWT_PRIVATE_KEY;
  const rawPub = env.OSN_JWT_PUBLIC_KEY;

  // S-H2: use OSN_ENV (the project's canonical env discriminator) rather than
  // NODE_ENV. A staging deploy with NODE_ENV=development would silently fall
  // through to an ephemeral key pair and issue tokens that can't survive restarts.
  if (isNonLocal(env) && (!rawPriv || !rawPub)) {
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

// ---------------------------------------------------------------------------
// Client-IP trust policy (S-M34)
//
// Controls how the rate limiter (and session-IP persistence) derives the
// caller's keying IP. `x-forwarded-for` is only trusted when this service
// actually sits behind a known number of reverse proxies — otherwise a
// client can forge the header and either evade or amplify per-IP limits.
//
//   TRUSTED_PROXY_COUNT  Integer ≥ 0. Number of trusted reverse proxies in
//                        front of @osn/api. The keying IP is taken N entries
//                        from the RIGHT of `x-forwarded-for` (spoofing-safe).
//                        Default 0 → direct mode.
// ---------------------------------------------------------------------------

export function parseTrustedProxyCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `TRUSTED_PROXY_COUNT must be a non-negative integer (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

/**
 * The {@link AppDeps} struct `createApp` consumes, plus the runtime-handles a
 * composition root uses after the app is built (the ephemeral-key warning flag
 * + the W3.3 trusted-proxy startup-warning predicates). The Bun entry also
 * threads its full observability layer back out for its startup banner.
 */
export interface BuiltDeps {
  deps: AppDeps;
  jwtEphemeral: boolean | undefined;
  /** True in a non-local deployment (drives W3.3 + key warnings). */
  envNonLocal: boolean;
  /** True when TRUSTED_PROXY_COUNT was never set (W3.3 startup warning). */
  trustedProxyCountUnconfigured: boolean;
}

/**
 * Runtime-specific handles a caller has already built (they differ between the
 * Bun and Workers entries) and hands to {@link buildAppDeps}:
 *
 * - `redisClient` — Bun: ioredis-or-memory via `initRedisClient`; Workers:
 *   Upstash-or-memory via `initRedisClientFromEnv` (env-gated by S-L1 there).
 * - `dbAndEmailLayer` — Bun: `DbLive` (bun:sqlite) merged with the email layer;
 *   Workers: `makeDbD1Live(env.DB)` merged with the email layer.
 * - `observabilityLayer` — Bun: the full `initObservability()` layer (OTel SDK);
 *   Workers: `osnLoggerLayer` (redacting logger only, workerd-safe).
 * - `includeObservabilityPlugin` — Bun: true; Workers: false (see AppDeps).
 */
export interface BuildParts {
  redisClient: RedisClient;
  dbAndEmailLayer: Layer.Layer<Db | EmailService>;
  observabilityLayer: Layer.Layer<never>;
  includeObservabilityPlugin: boolean;
  /**
   * Client-IP trust policy selector (Part 1 / S-M34). When `true`, per-IP
   * keying trusts Cloudflare's `cf-connecting-ip` header EXCLUSIVELY (never
   * falls back to the spoofable `x-forwarded-for`). The Workers entry sets this
   * for non-local tiers (osn-api runs behind Cloudflare on id.cireweddings.com);
   * the Bun entry leaves it `false` so local dev keeps socket-peer keying. When
   * `true`, `TRUSTED_PROXY_COUNT` is ignored (Cloudflare attribution wins).
   */
  trustCloudflare?: boolean;
  /**
   * Cloudflare Workers native Rate Limiting bindings (Part 2). Present only on
   * the Workers runtime when the `[[ratelimits]]` bindings are declared; the
   * Bun entry omits them. When present, the 60s-window per-IP auth limiters are
   * built from these (global + atomic edge enforcement) instead of Redis; every
   * other limiter/store stays on Redis. Absent ⇒ all limiters stay on Redis.
   */
  rateLimitBindings?: Partial<OsnRateLimitBindings>;
}

/**
 * Read every env-driven input, construct the Redis-backed stores/limiters from
 * the supplied client, build the Effect layer graph ONCE into a shared
 * `ManagedRuntime`, and package it all into the {@link AppDeps} struct
 * `createApp` consumes. Pure with respect to the runtime: the caller decides
 * the Redis backend, the DB/email layers, and the observability layer; this
 * function only wires them together. So the same code path serves both the Bun
 * dev server and the Cloudflare Workers isolate.
 *
 * Async only because {@link loadJwtKeyPair} may dynamically import `jose`; all
 * other wiring is synchronous.
 */
export async function buildAppDeps(env: EnvRecord, parts: BuildParts): Promise<BuiltDeps> {
  const {
    redisClient,
    dbAndEmailLayer,
    observabilityLayer,
    includeObservabilityPlugin,
    trustCloudflare = false,
    rateLimitBindings,
  } = parts;

  const jwt = await loadJwtKeyPair(env);
  const {
    privateKey: jwtPrivateKey,
    publicKey: jwtPublicKey,
    kid: jwtKid,
    jwtPublicKeyJwk,
    ephemeral: jwtEphemeral,
  } = jwt;

  const envNonLocal = isNonLocal(env);

  // S-M2: Session IP pepper is the HMAC key used to turn issuing IPs into
  // rainbow-table-resistant hashes on the `sessions.ip_hash` column. Fail
  // loudly if it's missing in a non-local deployment.
  const sessionIpPepper = env.OSN_SESSION_IP_PEPPER;
  if (envNonLocal && (!sessionIpPepper || sessionIpPepper.length < 32)) {
    throw new Error(
      "OSN_SESSION_IP_PEPPER must be set to at least 32 bytes in non-local environments",
    );
  }

  // Default issuer URL: workerd has no `PORT`; the Bun path used `:${port}`.
  // Non-local always sets OSN_ISSUER_URL explicitly, so the localhost default
  // only ever applies to local dev (Bun :4000 / `wrangler dev` :8787).
  const issuerUrl = env.OSN_ISSUER_URL || "http://localhost:4000";

  const authConfig = {
    rpId: env.OSN_RP_ID || "localhost",
    rpName: env.OSN_RP_NAME || "OSN",
    origin: (env.OSN_ORIGIN || "http://localhost:5173")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    issuerUrl,
    jwtPrivateKey,
    jwtPublicKey,
    jwtKid,
    jwtPublicKeyJwk,
    accessTokenTtl: Number(env.OSN_ACCESS_TOKEN_TTL) || 300,
    refreshTokenTtl: Number(env.OSN_REFRESH_TOKEN_TTL) || 2592000,
    sessionIpPepper,
  };

  // S-H1: cluster-safe single-use guard for step-up JWTs.
  const stepUpJtiStore = createRedisJtiStore(redisClient);

  // S-H1 (session): cluster-safe record of rotated-out session hashes so C2
  // reuse detection works across isolates/pods. S-M1 — `sanitizeCause` strips
  // any credentialed URL the client may embed in connection-level errors.
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

  const { ceremonyStores, recoveryLockoutStore, profileSwitchCap, emailChangeBeginCap } =
    createRedisCeremonyStores(redisClient, (store, op, cause) => {
      void Effect.runPromise(
        Effect.logWarning("Ceremony/lockout store Redis error").pipe(
          Effect.annotateLogs({ store, op, error: sanitizeCause(cause) }),
          Effect.provide(observabilityLayer),
        ),
      );
    });

  // Part 2: the 60s-window per-IP auth limiters move onto the Cloudflare Workers
  // native Rate Limiting binding when it's present (Workers, non-local), keyed
  // `"<endpoint>:" + ip` so endpoints sharing a budget tier don't share a
  // bucket. The three 1-hour-window per-IP limiters (recoveryGenerate,
  // recoveryComplete, emailChangeBegin) stay on Redis because the native binding
  // only supports period 10 or 60s. `selectAuthRateLimiters` leaves those slots
  // (and a 60s slot whose tier binding is missing) on the Redis fallback, so the
  // stateful stores' Upstash dependency is unchanged. Absent the bindings (Bun /
  // local `wrangler dev`) every limiter stays on Redis.
  const redisAuthRateLimiters = createRedisAuthRateLimiters(redisClient);
  const authRateLimiters = rateLimitBindings
    ? selectAuthRateLimiters(rateLimitBindings, redisAuthRateLimiters)
    : redisAuthRateLimiters;
  const graphRateLimiter = createRedisGraphRateLimiter(redisClient);
  const orgRateLimiter = createRedisOrgRateLimiter(redisClient);
  const profileRateLimiters = createRedisProfileRateLimiters(redisClient);
  const recommendationRateLimiter = createRedisRecommendationRateLimiter(redisClient);

  // Client-IP trust policy (Part 1 / S-M34). Behind Cloudflare (the non-local
  // Workers runtime — osn-api serves id.cireweddings.com), trust
  // `cf-connecting-ip` EXCLUSIVELY: `getClientIp({ trustCloudflare: true })`
  // never falls back to the spoofable `x-forwarded-for`, closing the per-IP
  // rate-limit bypass where an attacker forges XFF to rotate past the auth
  // limits. `TRUSTED_PROXY_COUNT` is the legacy XFF path, used ONLY when not
  // behind Cloudflare (e.g. local Bun dev keeps socket-peer keying with
  // trustedProxyCount = 0). Unresolved IPs still deny (429) — never bucket-share
  // — at the call sites via `isUnresolvedIp`.
  const trustedProxyCount = trustCloudflare ? 0 : parseTrustedProxyCount(env.TRUSTED_PROXY_COUNT);
  // The W3.3 startup warning only applies to the XFF/proxy path; under
  // Cloudflare attribution the proxy count is irrelevant, so never warn there.
  const trustedProxyCountUnconfigured = !trustCloudflare && env.TRUSTED_PROXY_COUNT === undefined;
  const clientIpConfig = trustCloudflare
    ? ({ trustCloudflare: true } as const)
    : ({ trustedProxyCount } as const);

  // C3: Cookie session config — Secure flag + __Host- prefix in non-local envs.
  const cookieConfig: CookieSessionConfig = { secure: envNonLocal };

  // Build the application layer graph ONCE into a long-lived runtime and thread
  // it through every route factory. Rebuilding the graph per request would
  // restart the full observability layer (and, on Bun, reopen the bun:sqlite
  // connection) every call. A single shared runtime collapses that to a
  // one-time boot cost. On Workers this runtime is cached per isolate, not per
  // request (P-I3).
  const appRuntime = ManagedRuntime.make(Layer.merge(dbAndEmailLayer, observabilityLayer));

  // S-L1: Restrict CORS to the known app origin. The fail-closed invariant
  // (S-L4) lives in `./lib/cors-config`. `cookieConfig.secure` is the single
  // non-local predicate — a deploy that forgets both `OSN_ENV` and
  // `OSN_CORS_ORIGIN` still fails closed at `assertCorsOriginsConfigured`.
  const corsOrigins = resolveCorsOrigins(env, cookieConfig.secure);
  assertCorsOriginsConfigured(corsOrigins, cookieConfig.secure);
  const originGuard = createOriginGuard({ allowedOrigins: new Set(corsOrigins) });

  const deps: AppDeps = {
    serviceName: SERVICE_NAME,
    includeObservabilityPlugin,
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
    // Gates the S2S service-registration endpoints. On workerd this is a
    // wrangler secret, surfaced via the `env` binding; on Bun it's process.env.
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
    // Turnstile bot protection (KEY-OPTIONAL). `TURNSTILE_SECRET_KEY` is a
    // wrangler secret (`env` on workerd, process.env on Bun). Unset ⇒ `null` ⇒
    // the register / passkey-login gates are skipped (flow unchanged). Set ⇒ a
    // fail-closed verifier enforces siteverify on those endpoints. The secret is
    // read here and never logged or placed in any other dep.
    turnstileVerifier: createTurnstileVerifier(env.TURNSTILE_SECRET_KEY),
    // AOT and the observability plugin co-vary by runtime: both ON for Bun,
    // both OFF for workerd (AOT's `new Function` is forbidden there). The
    // `includeObservabilityPlugin` flag is the single Bun-vs-Workers
    // discriminator the caller already supplies.
    aot: includeObservabilityPlugin,
  };

  return {
    deps,
    jwtEphemeral,
    envNonLocal,
    trustedProxyCountUnconfigured,
  };
}
