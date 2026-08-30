import type { D1Database } from "@cloudflare/workers-types";
import { makeDbD1Live } from "@zap/db/service";
import { Effect, Logger } from "effect";

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
let cached: { app: App; dbBinding: D1Database } | undefined;

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
let _registration: Promise<void> | undefined;

function ensureRegistered(): Promise<void> {
  _registration ??= registerWithOsnApi()
    .then((registered) => {
      if (registered) return;
      return Effect.runPromise(
        Effect.logWarning(
          "zap-api: ARC key registration skipped — INTERNAL_SERVICE_SECRET is unset. " +
            "Social-graph consent checks will fail closed (chats reject members) until it is set.",
        ).pipe(Effect.annotateLogs({ service: SERVICE_NAME }), Effect.provide(Logger.pretty)),
      ).catch(() => undefined);
    })
    .catch((err: unknown) => {
      // Reset so a subsequent request retries registration rather than caching
      // the failure for the isolate's whole lifetime.
      _registration = undefined;
      return Effect.runPromise(
        Effect.logError("zap-api: failed to register ARC key with osn/api", err).pipe(
          Effect.annotateLogs({ service: SERVICE_NAME }),
          Effect.provide(Logger.pretty),
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
      cached = { dbBinding: env.DB, app: buildApp(env) };
    }

    // Kick off (idempotent) ARC registration; don't block the request — consent
    // checks already fail closed if the key isn't registered yet.
    void ensureRegistered();

    return cached.app.fetch(request);
  },
};
