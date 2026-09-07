import type { D1Database } from "@cloudflare/workers-types";
import { loadConfig, parseDeploymentEnvironment } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { makeDbD1Live } from "@zap/db/service";
import { Effect, type Layer } from "effect";

import { createApp, SERVICE_NAME, type App } from "./app";
import { assertCorsOriginsConfigured, isNonLocalEnv, resolveCorsOrigins } from "./lib/cors-config";
import { DEFAULT_ISSUER_URL, DEFAULT_JWKS_URL } from "./lib/jwks";
import { registerWithOsnApi } from "./services/zapGraphBridge";

// Re-export the Eden treaty type so `@zap/api` consumers and `./client` keep
// importing `App` from the package entry point.
export type { App };
export { createApp } from "./app";

/**
 * Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [vars]);
 * regenerate the full set with `bunx wrangler types` when bindings change.
 * `DB` is optional so a misconfigured deployment fails at the edge with a 503
 * rather than a type lie.
 */
export interface Env {
  DB?: D1Database;
  /**
   * JWKS endpoint of the OSN issuer that signs access tokens (W1/W2 — ES256
   * verification). Required in deployed envs so the Worker verifies Bearer
   * tokens against the real OSN key set; an unset URL would otherwise leave
   * token verification unanchored.
   */
  OSN_JWKS_URL?: string;
  /** Expected `iss` on access tokens — osn-api's own `OSN_ISSUER_URL`. */
  OSN_ISSUER_URL?: string;
  /** CORS allowlist (S-M2), comma-separated. */
  ZAP_CORS_ORIGIN?: string;
  /** Environment discriminator — `local` vs anything else. */
  ZAP_ENV?: string;
  OSN_ENV?: string;
}

// Build the Elysia graph once per isolate — `env` bindings are stable within an
// isolate, and `aot: false` means none of the graph is amortised by
// compilation. Rebuild defensively if the D1 binding identity ever changes.
// The logger layer is built alongside it, for the same reason and with the same
// lifetime: one per isolate, not one per log call.
let cached: { app: App; dbBinding: D1Database; loggerLayer: Layer.Layer<never> } | undefined;

/**
 * Which tier is this Worker? Read from the request-scoped `env` binding, never
 * `process.env`: workerd only populates `process.env` from wrangler
 * `[vars]`/secrets on first access under `nodejs_compat_populate_process_env`,
 * and never during module evaluation — so reading it at import time would
 * silently resolve `local` on a live Worker. `ZAP_ENV ?? OSN_ENV` is the same
 * precedence `isNonLocalEnv` uses, so the logger can never disagree with the
 * fail-closed CORS guard about where it is running.
 *
 * The floor at `dev` is the one deliberate departure. `local` means "a human is
 * watching stdout", and that tier does not run this file — it runs `local.ts`
 * on Bun.serve (see the note at the top of `wrangler.toml`). Anything reaching
 * this module is workerd, where the log sink is Workers Logs: pretty output
 * there costs several ingested events per entry and cannot be queried by field.
 * `dev` is the mildest deployed tier, so an env block that names no tier at all
 * still gets one queryable JSON object per line rather than multi-line ANSI.
 *
 * `loadConfig` still runs so its S-L3 production-mismatch check applies.
 */
function loggerLayerFor(env: Env): Layer.Layer<never> {
  const tier = parseDeploymentEnvironment(env.ZAP_ENV ?? env.OSN_ENV);
  return makeLoggerLayer(
    loadConfig({ serviceName: SERVICE_NAME, env: tier === "local" ? "dev" : tier }),
  );
}

const misconfigured = (detail: string): Response =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

function buildApp(env: Env): App {
  const nonLocal = isNonLocalEnv({ ZAP_ENV: env.ZAP_ENV, OSN_ENV: env.OSN_ENV });

  // S-H (mirrors pulse-api): fetching JWKS over plaintext HTTP in a deployed
  // env lets any process with network access serve a forged key set.
  const jwksUrl = env.OSN_JWKS_URL;
  if (nonLocal && (!jwksUrl || jwksUrl.startsWith("http://"))) {
    throw new Error("OSN_JWKS_URL must be set and use HTTPS in non-local environments");
  }

  // The JWKS proves a key is genuine; `iss` proves the token was minted for
  // this deployment rather than another OSN install. Required in a deployed
  // env for the same reason the JWKS URL is: an unset expected issuer is not
  // a soft default, it is the check not running. It must match osn-api's own
  // `OSN_ISSUER_URL` byte for byte, so the two flip in the same deploy.
  // Presence is checked unconditionally; only the HTTPS requirement is
  // gated on the tier. A Worker whose env block sets neither `ZAP_ENV` nor
  // `OSN_ENV` reads as local, so gating presence too would let a publicly
  // reachable deployment run with no expected issuer at all — the check
  // silently off, which is the state this whole change exists to end.
  const issuer = env.OSN_ISSUER_URL || DEFAULT_ISSUER_URL;
  if (nonLocal && (!env.OSN_ISSUER_URL || issuer.startsWith("http://"))) {
    throw new Error("OSN_ISSUER_URL must be set and use HTTPS in non-local environments");
  }

  // S-M2: restrict CORS to a known origin allowlist instead of the open
  // reflect-any default. Fail closed in non-local envs (empty allowlist throws).
  const corsOrigins = resolveCorsOrigins({ ZAP_CORS_ORIGIN: env.ZAP_CORS_ORIGIN });
  assertCorsOriginsConfigured(corsOrigins, nonLocal);

  return createApp({
    dbLayer: makeDbD1Live(env.DB as D1Database),
    verification: { jwksUrl: jwksUrl ?? DEFAULT_JWKS_URL, issuer },
    corsOrigins,
  });
}

// ARC issuer self-registration. The long-lived Bun process registered once at
// boot; on Workers there is no boot hook, so we register lazily + idempotently
// the first time an isolate serves a request (the `_registration` promise is
// shared for the isolate's lifetime). Best-effort in local dev (a missing
// INTERNAL_SERVICE_SECRET logs a warning and continues — consent checks then
// fail closed); throws in non-local envs via the helper so a misconfigured
// deploy surfaces on the first request rather than silently mis-authing.
//
// Both log calls take the same redacting layer the rest of the service runs on
// (`makeLoggerLayer`), not the bare dev-server pretty logger they used to. This
// is the first request of every isolate in production, and the error branch logs
// an arbitrary caught `unknown` from `registerWithOsnApi` — every throw site
// reachable there today is benign (variable names, an HTTP status, a WebCrypto
// or workerd `TypeError`), so this is about the shape rather than a present
// leak. The layer buys three things the pretty logger has none of: the
// secret/PII deny-list over the message and its annotations, the configured
// minimum log level, and one queryable JSON object per line instead of
// multi-line ANSI in Workers Logs. `Logger.tracerLogger` is in both.
let _registration: Promise<void> | undefined;

function ensureRegistered(loggerLayer: Layer.Layer<never>): Promise<void> {
  _registration ??= registerWithOsnApi()
    .then((registered) => {
      if (registered) return;
      return Effect.runPromise(
        Effect.logWarning(
          "zap-api: ARC key registration skipped — INTERNAL_SERVICE_SECRET is unset. " +
            "Social-graph consent checks will fail closed (chats reject members) until it is set.",
        ).pipe(Effect.annotateLogs({ service: SERVICE_NAME }), Effect.provide(loggerLayer)),
      ).catch(() => undefined);
    })
    .catch((err: unknown) => {
      // Reset so a subsequent request retries registration rather than caching
      // the failure for the isolate's whole lifetime.
      _registration = undefined;
      return Effect.runPromise(
        Effect.logError("zap-api: failed to register ARC key with osn/api", err).pipe(
          Effect.annotateLogs({ service: SERVICE_NAME }),
          Effect.provide(loggerLayer),
        ),
      ).catch(() => undefined);
    });
  return _registration;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed at the edge if a required binding is missing rather than
    // falling back to the bun:sqlite `local` layer in a misconfigured deploy.
    if (!env.DB) return misconfigured("missing DB");

    if (!cached || cached.dbBinding !== env.DB) {
      cached = { dbBinding: env.DB, app: buildApp(env), loggerLayer: loggerLayerFor(env) };
    }

    // Kick off (idempotent) ARC registration; don't block the request — consent
    // checks already fail closed if the key isn't registered yet.
    void ensureRegistered(cached.loggerLayer);

    return cached.app.fetch(request);
  },
};
