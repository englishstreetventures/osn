import { readFileSync } from "node:fs";

import { DbLive } from "@osn/db/service";
import { initObservability, PrettyLoggerLive } from "@shared/observability";
import { Effect, Layer, ManagedRuntime } from "effect";

import { createApp, type App } from "./app";
import { buildAppDeps, type BuiltDeps, SERVICE_NAME } from "./build-deps";
import { createInMemoryCoordination } from "./lib/coordination/memory";
import { selectEmailLayer } from "./lib/email-layer";
import { keepSentClientAddress, type RequestAddress } from "./lib/local-client-address";
import { DELETION_SWEEP_DEFAULT_MAX_JOBS, deletionSweepMaxJobs } from "./services/account-erasure";
import { frontendOrigin } from "./services/auth/helpers";
import { runLocalSweeps } from "./services/sweeps";

export { SERVICE_NAME };
export const port = Number(process.env.PORT) || 4000;

/**
 * Bun composition root: read every `process.env`-driven input, initialise the
 * FULL observability layer (OTel SDK) + the in-memory coordination stores + the
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
  // Email transport (@shared/email) — selection shared with the Workers entry
  // via `selectEmailLayer`:
  //
  //   - Production/staging with RESEND_API_KEY → ResendEmailLive (preferred;
  //     POST to Resend's HTTP API, works on workerd). OSN_EMAIL_FROM is the
  //     verified sender. Wins over Cloudflare email + the degraded opt-in.
  //   - Else with CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN →
  //     CloudflareEmailLive (legacy fallback; creds win over the opt-in).
  //   - Non-local WITHOUT a real provider but with OSN_EMAIL_OPTIONAL truthy →
  //     NoopEmailLive (degraded: mail discarded, loud startup warning).
  //   - Non-local WITHOUT a real provider and WITHOUT the opt-in → throws
  //     (fail-closed). With Resend configured the opt-in is no longer needed.
  //   - Local dev / tests → LogEmailLive records sends to an in-memory ring, so
  //     no OTP codes end up in logs — unless RESEND_API_KEY and RESEND_API_URL
  //     are both set, which sends through ResendEmailLive to the local Resend
  //     emulator RESEND_API_URL names (a loopback origin; refused non-locally).
  // -------------------------------------------------------------------------
  // Both take the vars they read by name, and Bun types `process.env` as an
  // interface carrying only NODE_ENV/TZ — no name in common, which trips TS's
  // weak-type check. It is a plain string map underneath, so hand it over as one.
  //
  // `bun run dev` starts this file with `--devloop` (`dev:app` in
  // package.json). The devloop is the local tier, so there an unset OSN_ENV is
  // named `local`; a value from `osn/api/.env` or the shell still wins. Started
  // any other way, an unset OSN_ENV stays unset, and dev sign-in, which mounts
  // only on a named tier, stays off.
  const env: Readonly<Record<string, string | undefined>> =
    process.argv.includes("--devloop") && process.env.OSN_ENV === undefined
      ? { ...process.env, OSN_ENV: "local" }
      : process.env;

  const emailLayer = selectEmailLayer(env, observabilityLayer);

  const built = await buildAppDeps(env, {
    // One process, so its own memory is the shared state. A deployed Worker
    // runs many isolates and uses the Durable Object bundle instead.
    coordination: () => createInMemoryCoordination(),
    dbAndEmailLayer: Layer.merge(DbLive, emailLayer),
    observabilityLayer,
    // Bun path keeps the full per-request observability plugin (server span +
    // RED metrics). The Workers entry passes `false` — see AppDeps.
    includeObservabilityPlugin: true,
  });
  // A local stack may send its own change notices: the E2E stack names a
  // registry file of its own, since the one osn-api ships holds only notices
  // the owner approved. Read only here, the Bun entry, and only off the
  // deployed tiers; the Worker entry never reads it.
  const noticesFile = env.OSN_CHANGE_NOTICES_FILE;
  if (noticesFile && !built.envNonLocal) {
    built.deps.changeNotices = JSON.parse(readFileSync(noticesFile, "utf8"));
  }
  // Surface the concrete observability layer for the startup banner (the
  // AppDeps field is typed loosely as `Layer | undefined`).
  return { ...built, observabilityLayer };
}

/**
 * Bun-only startup side effects: bind the port, warn about ephemeral keys, and
 * start the account-erasure sweeper. Kept
 * out of `app.ts` (the pure factory) and out of the Workers path entirely (the
 * Workers entry moves the sweeper to a cron `scheduled` handler).
 */
export function startBunServer(
  app: App,
  built: Pick<
    BuiltDeps,
    "deps" | "jwtEphemeral" | "envNonLocal" | "trustedProxyCountUnconfigured"
  > & {
    observabilityLayer: Layer.Layer<never>;
  },
): void {
  const { observabilityLayer, jwtEphemeral, envNonLocal, trustedProxyCountUnconfigured } = built;

  // Unset, the server listens on every interface, as under `bun run dev`. The
  // E2E stack names a loopback address: the secrets it hands this server are
  // committed placeholders, so no other machine may reach it.
  const hostname = process.env.OSN_LOCAL_HOSTNAME || undefined;
  app.listen({ hostname, port, reusePort: false });
  // Only the E2E stack sets this, and only on a local server: the routes'
  // per-address limiters then key on a `cf-connecting-ip` the request sends,
  // so a flow can spend its own windows (`keepSentClientAddress`).
  const keepSentAddress = process.env.OSN_E2E_CLIENT_ADDRESS === "1" && !envNonLocal;
  if (keepSentAddress && app.server) {
    const server = app.server;
    // The socket peer, read through the server's own method as it stands
    // before the swap below (a closure over `server.requestIP` would call the
    // swapped one and never return).
    const socketPeer = server.requestIP.bind(server);
    const peer = (request: Request): RequestAddress => socketPeer(request);
    server.requestIP = keepSentClientAddress(peer);
  }
  void Effect.runPromise(
    Effect.gen(function* () {
      if (jwtEphemeral) {
        yield* Effect.logWarning(
          "Using ephemeral JWT key pair — tokens will be invalidated on restart. Set OSN_JWT_PRIVATE_KEY and OSN_JWT_PUBLIC_KEY for persistent keys.",
        );
      }
      // W3.3: warn if a non-local deploy hasn't declared its proxy
      // topology. Direct/socket-peer attribution behind an undeclared load
      // balancer collapses every user onto the LB's IP.
      if (envNonLocal && trustedProxyCountUnconfigured) {
        yield* Effect.logWarning(
          "TRUSTED_PROXY_COUNT is unset — rate limiting will key off the socket peer (direct mode). If @osn/api sits behind a reverse proxy / load balancer, set TRUSTED_PROXY_COUNT to the number of trusted hops so x-forwarded-for is honoured spoof-safely.",
        );
      }
      if (keepSentAddress) {
        yield* Effect.logWarning(
          "OSN_E2E_CLIENT_ADDRESS=1: rate limits key on a sent cf-connecting-ip. For the E2E stack only.",
        );
      }
      yield* Effect.logInfo("osn-app listening");
    }).pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(PrettyLoggerLive),
      Effect.provide(observabilityLayer),
    ),
  );

  // Fan-out retry, hard-delete, OIDC code, rotated-session and retention sweeper.
  // Single-instance — a multi-instance deploy would need a lock; for now the
  // fixed 6-hour cadence + idempotent per-row writes keep multi-instance safe
  // enough that a stray double-pass is a non-event. (The Workers entry runs the
  // same sweeps on a cron.)
  const SWEEPER_INTERVAL_MS =
    Number(process.env.OSN_DELETION_SWEEPER_INTERVAL_MS) || 6 * 60 * 60 * 1_000;
  // The apps the fan-out reaches come from the same settings the app was
  // built from (`buildAppDeps`), so the sweep and the routes agree.
  const maxJobs = deletionSweepMaxJobs(process.env.OSN_DELETION_FANOUT_MAX_JOBS);
  // Where the hard delete's emails point, as the routes' own emails do.
  const notices = {
    appUrl: frontendOrigin(built.deps.authConfig),
    instanceName: built.deps.authConfig.instanceName,
  };
  // Each sweep's failure, a defect included, is logged and the next sweep
  // still runs (`runLocalSweeps`). The sweeps run on the app's runtime, built
  // once at boot with the database, the email transport and observability:
  // one connection for every pass. A tick that finds the last pass still
  // running skips: two passes over one account would race each other.
  const sweepRuntime =
    built.deps.appRuntime ?? ManagedRuntime.make(Layer.merge(DbLive, observabilityLayer));
  let sweeping = false;
  const runSweep = (): void => {
    if (sweeping) return;
    sweeping = true;
    void sweepRuntime
      .runPromise(
        runLocalSweeps(
          built.deps.deletionApps,
          maxJobs === "invalid" ? DELETION_SWEEP_DEFAULT_MAX_JOBS : maxJobs,
          notices,
        ),
      )
      .catch(() => undefined)
      .finally(() => {
        sweeping = false;
      });
  };
  setInterval(runSweep, SWEEPER_INTERVAL_MS).unref?.();
}

// ---------------------------------------------------------------------------
// Bun dev entry (the default `dev` script: `bun run --watch src/local.ts --devloop`).
//
// The fast, native devloop: stable :4000, real passkey/OTP ceremonies, full
// OTel observability, in-memory rate limiters and stores, bun:sqlite. The
// Cloudflare Workers `index.ts` entry mirrors this composition from the `env`
// binding instead of `process.env`. Tests do NOT import this module — they
// build the app via `createApp` + a test layer.
// ---------------------------------------------------------------------------

const built = await buildAppDeps_Bun();
export const app = createApp(built.deps);
export type { App };

if (process.env.NODE_ENV !== "test") {
  startBunServer(app, {
    deps: built.deps,
    observabilityLayer: built.observabilityLayer,
    jwtEphemeral: built.jwtEphemeral,
    envNonLocal: built.envNonLocal,
    trustedProxyCountUnconfigured: built.trustedProxyCountUnconfigured,
  });
}
