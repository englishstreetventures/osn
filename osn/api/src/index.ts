import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { makeDbD1Live } from "@osn/db/service";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { Effect, Layer } from "effect";

import { createApp, type App } from "./app";
import { buildAppDeps, type EnvRecord } from "./build-deps";
import { selectEmailLayer } from "./lib/email-layer";
import { readOsnRateLimitBindings } from "./lib/native-rate-limiters";
import { registerOutboundKeysOnce } from "./lib/outbound-arc";
import { osnLoggerLayer } from "./observability";
import { initRedisClientFromEnv } from "./redis";
import * as accountErasure from "./services/account-erasure";
import { runExpiredAuthCodeSweep } from "./services/auth/oidc";

// ---------------------------------------------------------------------------
// Cloudflare Workers entry for @osn/api.
//
// Mirrors `cire/api/src/index.ts` (the proven Elysia-on-Workers template):
// per-isolate `cached`, fail-closed 503 on missing bindings/vars, build from
// the request-scoped `env` binding (NOT module-top `process.env`), and a cron
// `scheduled` handler for the deletion sweeper. The Bun dev server lives in
// `local.ts` and is unchanged. Everything env-driven is read from `env` here so
// the same `createApp` factory composes identically on workerd.
//
// Local `wrangler dev` (OSN_ENV unset/local) needs NO external services:
// Upstash absent ⇒ in-memory rate limiters/stores; D1 is miniflare-local.
// ---------------------------------------------------------------------------

/**
 * Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [vars],
 * secrets). Bindings/vars are optional in the type because a misconfigured
 * deployment must fail at the edge with a 503, not a type lie — `fetch` checks
 * the required set explicitly below.
 */
export interface Env {
  DB?: D1Database;
  // Cloudflare Workers native Rate Limiting bindings (Part 2). Declared as
  // `[[ratelimits]]` blocks in wrangler.toml (one per 60s budget tier), mirrored
  // into every named env. Present ONLY on the Workers runtime; when present the
  // 60s-window per-IP auth limiters run on these (global + atomic edge) instead
  // of Upstash. All optional: absent ⇒ those limiters fall back to Upstash.
  RL_AUTH_IP_5_60?: WorkersRateLimitBinding;
  RL_AUTH_IP_10_60?: WorkersRateLimitBinding;
  RL_AUTH_IP_20_60?: WorkersRateLimitBinding;
  RL_AUTH_IP_30_60?: WorkersRateLimitBinding;
  RL_AUTH_IP_60_60?: WorkersRateLimitBinding;
  // Non-secret vars (wrangler `[vars]`)
  OSN_ENV?: string;
  OSN_RP_ID?: string;
  OSN_RP_NAME?: string;
  OSN_ORIGIN?: string;
  OSN_ISSUER_URL?: string;
  OSN_CORS_ORIGIN?: string;
  OSN_ACCESS_TOKEN_TTL?: string;
  OSN_REFRESH_TOKEN_TTL?: string;
  OSN_EMAIL_FROM?: string;
  // Explicit opt-in: when truthy AND the Cloudflare email creds are absent in a
  // non-local env, osn-api boots with a no-op email transport (transactional
  // mail discarded, not delivered) instead of throwing. Unset = fail-closed.
  OSN_EMAIL_OPTIONAL?: string;
  // Where `/authorize` sends the browser when a request needs the user —
  // sign-in, profile choice, or consent. Unset falls back to `/authorize` on
  // the first configured origin.
  OSN_AUTHORIZE_UI_URL?: string;
  PULSE_API_URL?: string;
  ZAP_API_URL?: string;
  TRUSTED_PROXY_COUNT?: string;
  // Secrets (`wrangler secret put`) — present ONLY on `env`, never process.env.
  OSN_JWT_PRIVATE_KEY?: string;
  OSN_JWT_PUBLIC_KEY?: string;
  OSN_SESSION_IP_PEPPER?: string;
  // HMAC key behind every pairwise OIDC `sub`. Permanent: rotating it changes
  // every subject a relying party has on file. `wrangler secret put
  // OSN_PAIRWISE_SALT`.
  OSN_PAIRWISE_SALT?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // Preferred email transport (Resend HTTP API). When set in a non-local env,
  // ResendEmailLive is selected over Cloudflare email + the degraded opt-in.
  // `wrangler secret put RESEND_API_KEY`. See `lib/email-layer`.
  RESEND_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
  INTERNAL_SERVICE_SECRET?: string;
  // Turnstile bot-protection secret (KEY-OPTIONAL). When set, `/register/begin`
  // and `/login/passkey/begin` require a valid Turnstile token (fail-closed).
  // Unset ⇒ those gates are skipped. `wrangler secret put TURNSTILE_SECRET_KEY`.
  TURNSTILE_SECRET_KEY?: string;
}

const isNonLocal = (env: Env): boolean => !!env.OSN_ENV && env.OSN_ENV !== "local";

// P-I3: the Elysia app graph + the Upstash client + the shared Effect runtime
// (built inside `buildAppDeps`) are heavy to compose, so build them ONCE per
// isolate and cache — NOT per request. `env` bindings are stable within an
// isolate; the guard on the D1 binding identity rebuilds defensively if that
// ever changes. Nothing in the request path (`cached.app.fetch`) reconstructs
// any of them.
let cached: { app: App; dbBinding: D1Database } | undefined;

const misconfigured = (detail: string): Response =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Build the full app graph for this isolate from the `env` binding. Does what
 * `local.ts`'s Bun composition root does, but FROM `env` and with the
 * workerd-safe runtime handles: Upstash-or-memory Redis (S-L1 env-gated),
 * `makeDbD1Live(env.DB)`, the redacting `osnLoggerLayer`, and the per-request
 * observability plugin OFF (see AppDeps).
 */
export async function buildAll(env: Env): Promise<App> {
  // -------------------------------------------------------------------------
  // Redis — S-L1: env-gate the in-memory fallback.
  //
  // `initRedisClientFromEnv` silently downgrades to in-memory when the Upstash
  // bindings are absent. That is correct for local `wrangler dev`, but a
  // DEPLOYED Worker (OSN_ENV set & != "local") that lost its Upstash bindings
  // would otherwise silently run per-isolate in-memory rate-limiters /
  // step-up-jti — defeating cross-isolate brute-force + single-use guarantees.
  // Fail closed at construction, mirroring the Bun `REDIS_REQUIRED` posture.
  // -------------------------------------------------------------------------
  if (isNonLocal(env) && !(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in non-local environments — refusing to fall back to per-isolate in-memory rate limiters / step-up guard",
    );
  }
  const redisClient = initRedisClientFromEnv(env);

  // Email transport — same selection as the Bun path, from `env`. Fail-closed by
  // default in non-local; boots with a no-op transport (loud warning) ONLY when
  // the operator has explicitly set OSN_EMAIL_OPTIONAL. See `lib/email-layer`.
  const emailLayer = selectEmailLayer(env as unknown as EnvRecord, osnLoggerLayer);

  // D1-backed DB layer for this isolate. `env.DB` presence is asserted in
  // `fetch` before `buildAll` runs.
  const dbAndEmailLayer = Layer.merge(makeDbD1Live(env.DB as D1Database), emailLayer);

  // `buildAppDeps` reads only the string-valued vars/secrets; `env.DB` (a
  // non-string binding) is consumed above for the D1 layer. Cast to the loose
  // string record the factory expects.
  const built = await buildAppDeps(env as unknown as EnvRecord, {
    redisClient,
    dbAndEmailLayer,
    observabilityLayer: osnLoggerLayer,
    // Workers entry omits the per-request observability plugin: it calls
    // `process.hrtime.bigint()` on every request, which is not available on
    // workerd. `healthRoutes` + the redacting logger stay on (see AppDeps). The
    // x-request-id sanitization the plugin used to do is re-applied below (S-H3).
    includeObservabilityPlugin: false,
    // Part 1: behind Cloudflare in every deployed tier, trust `cf-connecting-ip`
    // exclusively for per-IP keying (never the spoofable XFF). Local `wrangler
    // dev` (OSN_ENV unset/"local") has no real CF in front, so keep the legacy
    // socket/XFF path there — `cf-connecting-ip` would be absent and every
    // request would resolve to UNRESOLVED_IP → deny.
    trustCloudflare: isNonLocal(env),
    // Part 2: the native Workers rate-limit bindings, when declared. Absent on
    // local `wrangler dev` without the bindings ⇒ all limiters stay on Upstash.
    rateLimitBindings: readOsnRateLimitBindings(env as unknown as Record<string, unknown>),
  });

  return createApp(built.deps);
}

/**
 * S-H3: the omitted observability plugin used to sanitize the inbound
 * `x-request-id` and echo it back. On the Workers path it's off, so re-apply
 * the same guard at the entry: only echo a client-supplied id when it matches
 * the strict format; otherwise mint a fresh one. Never echo a client-controlled
 * value back untouched (log / header / terminal injection).
 */
export const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function resolveRequestId(request: Request): string {
  const raw = request.headers.get("x-request-id");
  if (raw !== null && REQUEST_ID_RE.test(raw)) return raw;
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Hand-typed handler rather than `ExportedHandler<Env>`. workerd's own
 * `Request`/`Response` types (from `@cloudflare/workers-types`) diverge
 * structurally from the DOM/Bun globals that Elysia's `app.fetch` speaks
 * (`webSocket`, `cf`, `getSetCookie`, …). Annotating `fetch` with the global
 * `Request`/`Response` keeps the Elysia hand-off type-clean; the workerd runtime
 * passes a superset at call time, so this is sound. `scheduled` uses the real
 * workers types since it touches no DOM Request/Response.
 */
export const handler: {
  fetch(request: Request, env: Env): Promise<Response>;
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
} = {
  async fetch(request, env) {
    // Fail closed at the edge if any required binding/var is missing, rather
    // than letting createApp fall back to localhost dev defaults in a
    // misconfigured deployment.
    const missing = [
      !env.DB && "DB",
      // In a deployed tier the issuer/CORS/RP must be set explicitly — the
      // localhost defaults are local-dev only. `buildAppDeps` itself throws on
      // the security-critical missing secrets (JWT keys, IP pepper, Upstash,
      // CF email); surfacing those as a 503 happens via the try/catch below.
      isNonLocal(env) && !env.OSN_ISSUER_URL && "OSN_ISSUER_URL",
      isNonLocal(env) && !env.OSN_CORS_ORIGIN && "OSN_CORS_ORIGIN",
      isNonLocal(env) && !env.OSN_RP_ID && "OSN_RP_ID",
    ].filter(Boolean);
    if (missing.length > 0 || !env.DB) {
      return misconfigured(`missing ${missing.join(", ") || "DB"}`);
    }

    if (!cached || cached.dbBinding !== env.DB) {
      try {
        const app = await buildAll(env);
        cached = { app, dbBinding: env.DB };
      } catch (error) {
        // A misconfigured deploy (missing secret / Upstash gate / bad key)
        // fails LOUD as a 503 rather than serving a downgraded app.
        return misconfigured(error instanceof Error ? error.message : "build failed");
      }
    }

    // S-H3: sanitize + echo the request id (the observability plugin used to do
    // this; it's off on Workers). Inject the sanitized value on the way in so
    // any downstream logging sees the safe id, and echo it on the response.
    const requestId = resolveRequestId(request);
    const forwarded = new Request(request, { headers: new Headers(request.headers) });
    forwarded.headers.set("x-request-id", requestId);

    const response = await cached.app.fetch(forwarded);
    // Response from Elysia may have immutable headers; clone to set ours.
    const out = new Response(response.body, response);
    out.headers.set("x-request-id", requestId);
    return out;
  },

  // Cron-triggered maintenance. Replaces the Bun `setInterval` deletion sweeper
  // (account-erasure fan-out retry + hard-delete). Configured by the
  // `[triggers] crons` entry in wrangler.toml (every 6h — matching the Bun
  // SWEEPER_INTERVAL default). Two independent sweeps share the cron; each is
  // its own `waitUntil` + `catchAll` so a failure in one never aborts the other
  // and the isolate stays alive until each settles.
  //
  // ARC outbound-key registration on the Workers path. Pulse + Zap verify
  // inbound ARC tokens against a PRE-REGISTERED public key (Pulse:
  // `arc-middleware.ts` looks the kid up in an in-memory registry seeded by
  // `POST /internal/register-service`; osn's own register-service stores keys
  // in `service_account_keys` — there is NO JWKS-by-kid pull). The Bun server
  // registers osn's outbound key at boot via `startOutboundKeyRotation` in
  // `local.ts`. A workerd isolate has no boot hook, so we register here, once
  // per isolate, BEFORE the fan-out sweeps run — otherwise the very first
  // `/internal/account-deleted` POST would be 401'd by the downstream and the
  // GDPR Art. 17 erasure would stall. `outbound-arc.ts`'s lazy init only mints
  // the keypair; it does NOT publish the public key downstream. Registration is
  // an idempotent upsert; the once-per-isolate latch keeps every later cron
  // tick from re-POSTing. A failure here is logged and swallowed so a transient
  // downstream outage never aborts the sweeps (the next tick retries).
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    const dbLayer = makeDbD1Live(env.DB);
    const fanoutUrls = { pulseApiUrl: env.PULSE_API_URL, zapApiUrl: env.ZAP_API_URL };

    // Register the outbound ARC key, THEN run the fan-out retry sweep — awaited in
    // sequence within the tick so the first `/internal/account-deleted` POST on a
    // fresh isolate isn't 401'd before the key is published downstream. A
    // registration failure is logged and does not block the sweep (the POST then
    // 401s and is retried on the next tick, per the fail-and-retry posture below).
    ctx.waitUntil(
      (async () => {
        await registerOutboundKeysOnce({
          pulseApiUrl: env.PULSE_API_URL,
          zapApiUrl: env.ZAP_API_URL,
          internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
          osnEnv: env.OSN_ENV,
        }).catch((err) =>
          Effect.runPromise(
            Effect.logError("scheduled outbound ARC key registration failed", {
              reason: String(err),
            }).pipe(Effect.provide(osnLoggerLayer)),
          ),
        );
        await Effect.runPromise(
          accountErasure.runFanOutRetrySweep(fanoutUrls).pipe(
            Effect.catchAll((err) =>
              Effect.logError("scheduled fan-out retry sweep failed", { reason: String(err) }),
            ),
            Effect.provide(dbLayer),
            Effect.provide(osnLoggerLayer),
          ),
        );
      })(),
    );

    ctx.waitUntil(
      Effect.runPromise(
        accountErasure.runHardDeleteSweep().pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled hard-delete sweep failed", { reason: String(err) }),
          ),
          Effect.provide(dbLayer),
          Effect.provide(osnLoggerLayer),
        ),
      ),
    );

    // Reap OIDC authorization codes that were minted and never exchanged. A
    // redeemed code deletes itself; only abandoned or endpoint-spammed codes
    // outlive their 60s TTL, and left unswept they grow without bound.
    ctx.waitUntil(
      Effect.runPromise(
        runExpiredAuthCodeSweep().pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled OIDC code sweep failed", { reason: String(err) }),
          ),
          Effect.provide(dbLayer),
          Effect.provide(osnLoggerLayer),
        ),
      ),
    );
  },
};

export default handler;
