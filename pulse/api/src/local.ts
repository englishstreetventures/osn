import { DbLive } from "@pulse/db/service";
import { initObservability } from "@shared/observability";
import type { ClientIpOptions } from "@shared/rate-limit";
import { Effect, Logger } from "effect";

import { createApp, SERVICE_NAME } from "./app";
import { assertCorsOriginsConfigured, resolveCorsOrigins } from "./lib/cors-config";
import { registerLeaveAppKeyWithOsnApi } from "./lib/outbound-arc";
import { initRedisClient, makeRateLimiters } from "./redis";
import * as accountErasure from "./services/accountErasure";
import { startKeyRotation } from "./services/graphBridge";

// `local` environment entry point: long-lived Bun.serve process backed by
// bun:sqlite (the default `DbLive` layer inside `createApp`), plus the
// background jobs that only make sense on a long-lived host (ARC key rotation,
// the deletion sweepers). The `dev` / `staging` / `prod` environments run the
// Workers entry (`index.ts`) over D1; sweepers there move to a Cron trigger
// (tracked in wiki/TODO.md).
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

const nonLocal = process.env.OSN_ENV && process.env.OSN_ENV !== "local";

// S-H3: fetching public keys over plaintext HTTP in a deployed env allows
// any process with network access to serve a forged JWK set. Fail fast.
const jwksUrl = process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";
if (nonLocal && jwksUrl.startsWith("http://")) {
  throw new Error("OSN_JWKS_URL must use HTTPS in non-local environments");
}

// ---------------------------------------------------------------------------
// Redis composition root — env-driven backend selection (mirrors osn/api).
// `REDIS_URL` set → Redis-backed limiters (shared across processes, survives
// restarts). Unset → in-memory fallback. The route factories accept injected
// backends, so the only thing that changes between local and production is the
// backing store, never the policy / call sites.
// ---------------------------------------------------------------------------
const redisClient = await initRedisClient({
  redisUrl: process.env.REDIS_URL,
  redisRequired: process.env.REDIS_REQUIRED === "true",
  nodeEnv: process.env.NODE_ENV,
  loggerLayer: observabilityLayer,
});
const rateLimiters = makeRateLimiters(redisClient);

// ---------------------------------------------------------------------------
// Client-IP trust policy (S-M34) for the per-IP limiters on the
// unauthenticated discover / share / exposure surfaces.
// `PULSE_TRUSTED_PROXY_COUNT` is the number of trusted reverse proxies: the
// keying IP is taken that many hops from the right of `x-forwarded-for`.
// Unset → direct mode (socket peer). Behind Cloudflare set `trustCloudflare`.
// ---------------------------------------------------------------------------
function parseTrustedProxyCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `PULSE_TRUSTED_PROXY_COUNT must be a non-negative integer (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}
const trustedProxyCount = parseTrustedProxyCount(process.env.PULSE_TRUSTED_PROXY_COUNT);
const trustedProxyCountUnconfigured = process.env.PULSE_TRUSTED_PROXY_COUNT === undefined;
const clientIpConfig: Omit<ClientIpOptions, "socketIp"> = { trustedProxyCount };

// CORS allowlist (P3) — replaces the bare `cors()` wildcard; fail closed in
// non-local envs where `PULSE_CORS_ORIGIN` is unset.
const corsOrigins = resolveCorsOrigins(process.env, !!nonLocal);
assertCorsOriginsConfigured(corsOrigins, !!nonLocal);

const app = createApp({ jwksUrl, rateLimiters, clientIpConfig, corsOrigins });

const port = process.env.PORT || 3001;

// S-M34: warn when running non-local without an explicit proxy count — the
// per-IP limiters then key off the socket peer (direct mode). Behind a load
// balancer that means everyone shares the LB's IP; set
// PULSE_TRUSTED_PROXY_COUNT to the number of trusted hops.
if (nonLocal && trustedProxyCountUnconfigured) {
  void Effect.runPromise(
    Effect.logWarning(
      "PULSE_TRUSTED_PROXY_COUNT is unset — per-IP rate limiting will key off the socket peer (direct mode). If @pulse/api sits behind a reverse proxy / load balancer, set PULSE_TRUSTED_PROXY_COUNT to the number of trusted hops so x-forwarded-for is honoured spoof-safely.",
    ).pipe(Effect.provide(Logger.pretty), Effect.provide(observabilityLayer)),
  ).catch(() => undefined);
}

app.listen({ port, reusePort: false });

// Register our ephemeral public key with osn/api and schedule automatic
// rotation. Exits the process only on unrecoverable errors (missing secret in
// non-local, HTTP 4xx/5xx, etc). In local dev, a missing secret or an
// unreachable osn/api logs a warning and lets the server boot — the latter
// schedules a background retry so `bun run dev:pulse` is resilient to turbo
// starting both services in parallel.
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
// so it picks up resource attributes + redaction.
void Effect.runPromise(
  Effect.logInfo("pulse-api listening (local / bun:sqlite)").pipe(
    Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
    Effect.provide(Logger.pretty),
    Effect.provide(observabilityLayer),
  ),
);

// Register the leave-app outbound key with osn-api so step-up verify +
// enrollment-leave callbacks can be ARC-authenticated. Best-effort in local
// dev; throws in non-local environments via the helper itself.
void registerLeaveAppKeyWithOsnApi().catch(() => undefined);

// Sweepers — Pulse leave-app hard-delete + event-cancellation hard-delete.
// Single-instance for now; single-pod ops are fine because the writes are
// idempotent and per-row. Production should add a Redis lock here.
const SWEEPER_INTERVAL_MS =
  Number(process.env.PULSE_DELETION_SWEEPER_INTERVAL_MS) || 6 * 60 * 60 * 1_000;
const runSweep = (): void => {
  void Effect.runPromise(
    Effect.gen(function* () {
      yield* accountErasure.runHardDeleteSweep();
      yield* accountErasure.runEventCancellationSweep();
    }).pipe(Effect.provide(DbLive)) as Effect.Effect<unknown, never, never>,
  ).catch(() => undefined);
};
setInterval(runSweep, SWEEPER_INTERVAL_MS).unref?.();
