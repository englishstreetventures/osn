import type { D1Database } from "@cloudflare/workers-types";
import { makeDbD1Live } from "@pulse/db/service";
import { parseDeploymentEnvironment } from "@shared/observability/config";
import type { ClientIpOptions } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp, type App } from "./app";
import { assertCorsOriginsConfigured, resolveCorsOrigins } from "./lib/cors-config";
import { buildPulseOidcConfig } from "./lib/oidc";
import { makeMemoryRateLimiters, type PulseRateLimiters } from "./redis";

// Re-export the Eden treaty type so `@pulse/api` consumers and `./client` keep
// importing `App` from the package entry point.
export type { App };
export { createApp } from "./app";

/**
 * Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [vars]);
 * regenerate with `bunx wrangler types` when bindings change. `DB` is optional
 * so a misconfigured deployment fails at the edge with a 503, not a type lie.
 *
 * NOTE: the leave-app sweepers (`runHardDeleteSweep` /
 * `runEventCancellationSweep`) run on the long-lived `local` host (`local.ts`).
 * On Workers they belong on a Cron Trigger — tracked in wiki/TODO.md.
 */
export interface Env {
  DB?: D1Database;
  /** JWKS endpoint of the OSN issuer that signs access tokens. */
  OSN_JWKS_URL?: string;
  /** CORS allowlist (P3), comma-separated. */
  PULSE_CORS_ORIGIN?: string;
  /** Number of trusted reverse proxies in front of the Worker (S-M34). */
  PULSE_TRUSTED_PROXY_COUNT?: string;
  /** Environment discriminator — `local` vs anything else. */
  OSN_ENV?: string;
  /** OSN issuer origin — the OIDC provider this app is a relying party of. */
  OSN_ISSUER_URL?: string;
  /**
   * Public origin of this Worker. The registered redirect URI is
   * `${PULSE_API_ORIGIN}/api/auth/oidc/callback`, and the session cookie is
   * host-scoped to it — so it must be same-site with the Pulse web origin
   * (`api.<pulse-domain>`) or a `SameSite=Lax` cookie is never sent.
   */
  PULSE_API_ORIGIN?: string;
  /** OIDC client id registered with osn-api (var). */
  OSN_OIDC_CLIENT_ID?: string;
  /** OIDC client secret (secret, never a var). */
  OSN_OIDC_CLIENT_SECRET?: string;
  /** Absolute URL of the Pulse web login page — the `?auth_error` landing. */
  PULSE_LOGIN_URL?: string;
}

/**
 * Client-IP trust policy (S-M34) for the per-IP limiters on the unauthenticated
 * discover / share / exposure surfaces. `PULSE_TRUSTED_PROXY_COUNT` is the
 * number of trusted reverse proxies in front of the Worker: the keying IP is
 * taken that many hops from the right of `x-forwarded-for` (the only
 * spoofing-resistant strategy). Unset → direct mode (socket peer). When fronted
 * by Cloudflare proper, key off `cf-connecting-ip` via `trustCloudflare`.
 */
function resolveClientIpConfig(env: Env): Omit<ClientIpOptions, "socketIp"> {
  const raw = env.PULSE_TRUSTED_PROXY_COUNT;
  if (raw === undefined || raw.trim() === "") return { trustedProxyCount: 0 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `PULSE_TRUSTED_PROXY_COUNT must be a non-negative integer (got ${JSON.stringify(raw)})`,
    );
  }
  return { trustedProxyCount: n };
}

// Build the Elysia graph once per isolate — `env` bindings are stable within an
// isolate, and `aot: false` means none of the graph is amortised by
// compilation. Rebuild defensively if the D1 binding identity ever changes.
//
// Rate limiters use in-memory counters per isolate. The W4 limiters remain the
// correct policy + call sites; a globally-shared throttle on Workers belongs on
// a durable backing store (KV / Durable Object / Workers rate-limit binding) —
// tracked in wiki/TODO.md. We never silently downgrade an explicitly-configured
// distributed limiter because none is wired here yet.
let cached: { app: App; dbBinding: D1Database } | undefined;

const misconfigured = (detail: string): Response =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

function buildApp(env: Env): App {
  const secure = !!env.OSN_ENV && env.OSN_ENV !== "local";

  // S-H (mirrors zap-api): fetching JWKS over plaintext HTTP in a deployed env
  // lets any process with network access serve a forged key set and mint
  // acceptable access tokens. Fail closed on a missing/plaintext URL.
  const jwksUrl = env.OSN_JWKS_URL;
  if (secure && (!jwksUrl || jwksUrl.startsWith("http://"))) {
    throw new Error("OSN_JWKS_URL must be set and use HTTPS in non-local environments");
  }

  // CORS allowlist — fail closed in non-local envs where PULSE_CORS_ORIGIN is
  // unset (an empty allowlist in a secure env is a misconfiguration).
  const corsOrigins = resolveCorsOrigins({ PULSE_CORS_ORIGIN: env.PULSE_CORS_ORIGIN }, secure);
  assertCorsOriginsConfigured(corsOrigins, secure);

  const rateLimiters: PulseRateLimiters = makeMemoryRateLimiters();

  // Browser sign-in (OIDC relying party). All five pieces or none — see
  // `lib/oidc.ts`. On a deployed tier an incomplete set is a misconfiguration
  // worth a log line, but not worth refusing to serve: every other route works
  // without it, and the sign-in legs answer `sign_in_unavailable`.
  const oidc = buildPulseOidcConfig(env, corsOrigins);
  if (secure && !oidc) {
    void Effect.runPromise(
      Effect.logError(
        "pulse-api: OIDC sign-in disabled — set OSN_ISSUER_URL, OSN_JWKS_URL, PULSE_API_ORIGIN, OSN_OIDC_CLIENT_ID and OSN_OIDC_CLIENT_SECRET to enable it",
      ),
    ).catch(() => undefined);
  }

  return createApp({
    dbLayer: makeDbD1Live(env.DB as D1Database),
    jwksUrl,
    rateLimiters,
    clientIpConfig: resolveClientIpConfig(env),
    corsOrigins,
    oidc,
    secureCookies: secure,
    // OpenAPI docs on `local` and `dev` only — see `AppOptions.includeOpenapi`.
    // Derived from the request-scoped binding, never `process.env`: workerd
    // leaves that empty during module evaluation, so a decision made at import
    // time would read every deployed tier as `local` and serve the docs
    // everywhere. Fails closed — `secure` treats anything that isn't exactly
    // `local` as deployed, and the parser answers `dev` only for
    // `dev`/`development`, so an unrecognised tier string is off, not on.
    includeOpenapi: !secure || parseDeploymentEnvironment(env.OSN_ENV) === "dev",
    ...(env.PULSE_LOGIN_URL ? { loginFallbackUrl: env.PULSE_LOGIN_URL } : {}),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed at the edge if the D1 binding is missing rather than falling
    // back to the bun:sqlite `local` layer in a misconfigured deployment.
    if (!env.DB) return misconfigured("missing DB");

    if (!cached || cached.dbBinding !== env.DB) {
      cached = { dbBinding: env.DB, app: buildApp(env) };
    }

    return cached.app.fetch(request);
  },
};
