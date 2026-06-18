import { DbLive } from "@osn/db/service";
import { initObservability } from "@shared/observability";
import { Effect, Layer, Logger } from "effect";

import { createApp, type App } from "./app";
import { buildAppDeps, type BuiltDeps, SERVICE_NAME } from "./build-deps";
import { selectEmailLayer } from "./lib/email-layer";
import { startOutboundKeyRotation } from "./lib/outbound-arc";
import { initRedisClient } from "./redis";
import * as accountErasure from "./services/account-erasure";

export { SERVICE_NAME };
export const port = Number(process.env.PORT) || 4000;

/**
 * Bun composition root: read every `process.env`-driven input, initialise the
 * FULL observability layer (OTel SDK) + the ioredis-or-memory client + the
 * email transport, then hand them to the shared {@link buildAppDeps} (which is
 * runtime-agnostic and shared with the Workers `index.ts` entry). The Effect
 * layer graph is built ONCE inside `buildAppDeps` into a shared `ManagedRuntime`
 * (CLAUDE.md > Effect runtime).
 */
export async function buildAppDeps_Bun(): Promise<
  BuiltDeps & { observabilityLayer: Layer.Layer<never> }
> {
  // Initialise observability (logger, tracing, metrics) before building the app.
  const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

  // -------------------------------------------------------------------------
  // Redis client — env-driven backend selection (S-M2). See `./redis.ts` for
  // the full lifecycle (TLS warning, credential redaction, REDIS_REQUIRED
  // fail-closed mode, lazyConnect).
  // -------------------------------------------------------------------------
  const redisClient = await initRedisClient({
    redisUrl: process.env.REDIS_URL,
    redisRequired: process.env.REDIS_REQUIRED === "true",
    nodeEnv: process.env.NODE_ENV,
    loggerLayer: observabilityLayer,
  });

  // -------------------------------------------------------------------------
  // Email transport (@shared/email) — selection shared with the Workers entry
  // via `selectEmailLayer`:
  //
  //   - Production/staging with CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN
  //     → CloudflareEmailLive (POST to Cloudflare's Email Service REST API; creds
  //     always win). OSN_EMAIL_FROM is the verified sender.
  //   - Non-local WITHOUT creds but with OSN_EMAIL_OPTIONAL set truthy →
  //     NoopEmailLive (degraded: mail discarded, loud startup warning).
  //   - Non-local WITHOUT creds and WITHOUT the opt-in → throws (fail-closed).
  //   - Local dev / tests → LogEmailLive records sends to an in-memory ring, so
  //     no OTP codes end up in logs.
  // -------------------------------------------------------------------------
  const emailLayer = selectEmailLayer(process.env, observabilityLayer);

  const built = await buildAppDeps(process.env, {
    redisClient,
    dbAndEmailLayer: Layer.merge(DbLive, emailLayer),
    observabilityLayer,
    // Bun path keeps the full per-request observability plugin (server span +
    // RED metrics). The Workers entry passes `false` — see AppDeps.
    includeObservabilityPlugin: true,
  });
  // Surface the concrete observability layer for the startup banner (the
  // AppDeps field is typed loosely as `Layer | undefined`).
  return { ...built, observabilityLayer };
}

/**
 * Bun-only startup side effects: bind the port, warn about ephemeral keys, kick
 * off outbound ARC key rotation, and start the account-erasure sweeper. Kept
 * out of `app.ts` (the pure factory) and out of the Workers path entirely (the
 * Workers entry moves the sweeper to a cron `scheduled` handler).
 */
export function startBunServer(
  app: App,
  built: Pick<BuiltDeps, "jwtEphemeral" | "envNonLocal" | "trustedProxyCountUnconfigured"> & {
    observabilityLayer: Layer.Layer<never>;
  },
): void {
  const { observabilityLayer, jwtEphemeral, envNonLocal, trustedProxyCountUnconfigured } = built;

  app.listen({ port, reusePort: false });
  void Effect.runPromise(
    Effect.gen(function* () {
      if (jwtEphemeral) {
        yield* Effect.logWarning(
          "Using ephemeral JWT key pair — tokens will be invalidated on restart. Set OSN_JWT_PRIVATE_KEY and OSN_JWT_PUBLIC_KEY for persistent keys.",
        );
      }
      // W3.3 (S-M34): warn if a non-local deploy hasn't declared its proxy
      // topology. Direct/socket-peer attribution behind an undeclared load
      // balancer collapses every user onto the LB's IP.
      if (envNonLocal && trustedProxyCountUnconfigured) {
        yield* Effect.logWarning(
          "TRUSTED_PROXY_COUNT is unset — rate limiting will key off the socket peer (direct mode). If @osn/api sits behind a reverse proxy / load balancer, set TRUSTED_PROXY_COUNT to the number of trusted hops so x-forwarded-for is honoured spoof-safely.",
        );
      }
      yield* Effect.logInfo("osn-app listening");
    }).pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );

  // Outbound ARC key registration with downstream services. Used by the
  // account-erasure fan-out to call Pulse / Zap `/internal/account-deleted`.
  // Falls through gracefully in local dev when downstreams aren't up yet.
  void startOutboundKeyRotation({
    pulseApiUrl: process.env.PULSE_API_URL,
    zapApiUrl: process.env.ZAP_API_URL,
    internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET,
    osnEnv: process.env.OSN_ENV,
  }).catch(() => undefined);

  // Hard-delete + fan-out retry sweeper. Single-instance — production should
  // wrap with a Redis lock; for now the fixed 6-hour cadence + idempotent
  // per-row writes keep multi-instance safe enough that a stray double-pass
  // is a non-event. (The Workers entry runs the same two sweeps on a cron.)
  const SWEEPER_INTERVAL_MS =
    Number(process.env.OSN_DELETION_SWEEPER_INTERVAL_MS) || 6 * 60 * 60 * 1_000;
  const fanoutUrls = {
    pulseApiUrl: process.env.PULSE_API_URL,
    zapApiUrl: process.env.ZAP_API_URL,
  };
  const runSweep = (): void => {
    void Effect.runPromise(
      Effect.gen(function* () {
        yield* accountErasure.runFanOutRetrySweep(fanoutUrls);
        yield* accountErasure.runHardDeleteSweep();
      }).pipe(Effect.provide(DbLive), Effect.provide(observabilityLayer)) as Effect.Effect<
        unknown,
        never,
        never
      >,
    ).catch(() => undefined);
  };
  setInterval(runSweep, SWEEPER_INTERVAL_MS).unref?.();
}

// ---------------------------------------------------------------------------
// Bun dev entry (the default `dev` script: `bun run --watch src/local.ts`).
//
// The fast, native devloop: stable :4000, real passkey/OTP ceremonies, full
// OTel observability, ioredis-or-memory rate limiters, bun:sqlite. The
// Cloudflare Workers `index.ts` entry mirrors this composition from the `env`
// binding instead of `process.env`. Tests do NOT import this module — they
// build the app via `createApp` + a test layer.
// ---------------------------------------------------------------------------

const built = await buildAppDeps_Bun();
export const app = createApp(built.deps);
export type { App };

if (process.env.NODE_ENV !== "test") {
  startBunServer(app, {
    observabilityLayer: built.observabilityLayer,
    jwtEphemeral: built.jwtEphemeral,
    envNonLocal: built.envNonLocal,
    trustedProxyCountUnconfigured: built.trustedProxyCountUnconfigured,
  });
}
