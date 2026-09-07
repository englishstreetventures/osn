import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { makeOtlpTracing, type OtlpTracing } from "@shared/observability/tracing";
import { Effect, Layer, ManagedRuntime } from "effect";

/**
 * Redacting logger + OTLP trace export for osn/api — the workerd-safe sibling
 * of the full `initObservability()` layer used on the Bun path (`local.ts`).
 *
 * ## Logging
 *
 * Replaces Effect's default logger with the shared OSN redacting logger (json
 * in prod / pretty in dev) so every `Effect.log*` message + annotation is run
 * through the secret/PII deny-list (`@shared/observability/logger`'s `redact`)
 * before serialization. Without this layer osn's log calls fall through to
 * Effect's *default* logger and annotated PII — `email`, `token`, `sessionId`,
 * `passwordHash`, … — is NOT scrubbed.
 *
 * ## Tracing
 *
 * `makeOtlpTracing` sets the `Tracer.Tracer` reference to an OTLP/HTTP exporter
 * built on `effect/unstable/observability` + `globalThis.fetch` — no
 * `@effect/opentelemetry` `NodeSdk`, no `@opentelemetry/sdk-*`, so it runs on
 * workerd. Until this existed, every `Effect.withSpan` in the deployed identity
 * Worker recorded into Effect's in-memory default tracer and was dropped.
 *
 * This layer is what `index.ts` hands `buildAppDeps` as its
 * `observabilityLayer`, and `build-deps.ts` merges it into the shared
 * `appRuntime` every route factory runs on — so wiring it here is what puts the
 * tracer in front of the route spans, without touching a single route.
 *
 * It is **inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**: with no endpoint
 * the tracing layer is `Layer.empty`, {@link flushOsnTelemetry} is a no-op and
 * nothing is ever POSTed, so a tier that has not been given a collector behaves
 * exactly as it did before. See `wrangler.toml` for the two vars.
 *
 * **Spans only drain when {@link flushOsnTelemetry} is called.** The exporter's
 * background export interval is deliberately pushed out of reach, because on
 * workerd no fiber survives between requests and a cancelled background export
 * disables the exporter — dropping spans — for 60 seconds. `index.ts` calls the
 * flush inside `ctx.waitUntil(...)` once the response is ready. Full reasoning
 * in `shared/observability/src/tracing/otlp.ts`.
 *
 * Known limitation: `@shared/observability`'s `instrumentedFetch` and its
 * `traceparent` propagation helpers use the raw `@opentelemetry/api` registry,
 * which nothing bridges to Effect's tracer — so an inbound `traceparent` does
 * not become the parent of these spans, and what is exported is a correctly
 * attributed root span per `run` call rather than one joined request trace.
 *
 * ## Why this is built lazily
 *
 * Configured from env (`OSN_ENV` / `OSN_LOG_LEVEL` / `OTEL_EXPORTER_OTLP_*`,
 * parsed by `loadConfig`), but built LAZILY — `Layer.suspend` defers
 * `loadConfig` to the first time the layer is actually provided to an effect,
 * which is always inside a request or cron handler. On workerd this is
 * load-bearing: `nodejs_compat_populate_process_env` fills `process.env` from
 * wrangler `[vars]` + secrets on first access, and during module evaluation
 * there is nothing to read yet — a config parsed at module load would see an
 * empty `process.env`, pin every deployed tier to `local` (pretty logs, debug
 * level) AND see no OTLP endpoint, silently disabling export forever. In
 * bun:sqlite tests and the local dev server `process.env` is native and the
 * timing makes no difference. The result is memoised, so the config is parsed
 * once per isolate, not once per request.
 *
 * Workerd-safe: the `/logger`, `/config` and `/tracing` subpaths import only
 * `effect` plus the dependency-free `@opentelemetry/api` façade (already in the
 * bundle via `@shared/observability/metrics`) — no `NodeSdk`, no Node built-ins.
 * `shared/observability/tests/tracing/workerd-safety.test.ts` walks the static
 * import graph of each of those subpaths and fails if that stops being true.
 * The Bun entry (`local.ts`) is unchanged and keeps providing the FULL logger +
 * NodeSdk tracing + metrics layer via `initObservability()`.
 *
 * Metric export is still deferred and out of scope here: `@shared/observability`
 * builds its instruments from the raw `@opentelemetry/api` meter rather than
 * Effect's `Metric`, so Effect's `OtlpMetrics` cannot see any of them. The
 * counters remain correct, type-checked no-ops on workerd.
 *
 * Typed as `Layer.Layer<never>` so it stays interchangeable with the full
 * observability layer in the app runtime / every route-factory signature — no
 * signature changes required. (`Tracer.Tracer` is a context *reference*, which
 * always has a default and so is erased from a layer's output type; that is why
 * attaching a tracer does not widen this type.)
 *
 * The name is historical: it carries tracing now as well as the logger, but it
 * is threaded through files outside this change's scope, so renaming it is a
 * separate mechanical patch.
 */
let builtLayer: Layer.Layer<never> | undefined;
let tracing: OtlpTracing | undefined;

export const osnLoggerLayer: Layer.Layer<never> = Layer.suspend(() => {
  if (!builtLayer) {
    const config = loadConfig({ serviceName: "osn-api" });
    tracing = makeOtlpTracing(config);
    builtLayer = Layer.merge(makeLoggerLayer(config), tracing.layer);
  }
  return builtLayer;
});

/**
 * Module-scope runtime for `osnLoggerLayer`, mirroring cire/api's. `runOsn` and
 * `runOsnSync` used to be `Effect.runPromise(Effect.provide(effect, layer))`,
 * which rebuilds the whole layer graph per call. That was merely wasteful for a
 * logger; with trace export attached it is not, because `Effect.provide` opens
 * AND CLOSES the layer's scope around each run — so every call would construct
 * and immediately tear down an OTLP exporter.
 *
 * Safe with the `Layer.suspend` above left intact: `ManagedRuntime.make` only
 * runs `scopeMake` at construction (pure, no env access) — it does not force
 * the layer, so `loadConfig` still never runs during module evaluation.
 */
const osnRuntime = ManagedRuntime.make(osnLoggerLayer);

/**
 * Run a fully-resolved osn effect to a Promise with the redacting logger
 * installed. The effect must already have its services (`DbService`,
 * `EmailService`, …) provided and its typed errors handled — this only swaps in
 * the logger. Use on the Workers path instead of bare `Effect.runPromise` so no
 * log line escapes redaction.
 */
export const runOsn = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  osnRuntime.runPromise(effect);

/**
 * Synchronous counterpart for framework error boundaries and startup banners,
 * where there is no Promise to await.
 */
export const runOsnSync = <A, E>(effect: Effect.Effect<A, E, never>): A =>
  osnRuntime.runSync(effect);

/**
 * Drain every span buffered by this isolate to the OTLP collector.
 *
 * Call from `ctx.waitUntil(...)` in the Worker entry, AFTER the response has
 * been produced — every span that request opened has ended by then, and
 * `waitUntil` is what keeps the isolate alive long enough for the POST. This is
 * the ONLY reliable drain on workerd (see the module docstring).
 *
 * Drains EVERY live exporter, not just this runtime's: osn/api builds
 * `osnLoggerLayer` into two long-lived runtimes — this module's and the shared
 * `appRuntime` in `build-deps.ts`, which is the one the route spans are
 * actually recorded on — and a `Layer` is memoized per `MemoMap`, so each gets
 * its own exporter. `makeOtlpTracing` tracks all live ones for exactly this
 * reason; see `shared/observability/src/tracing/otlp.ts`.
 *
 * Never rejects and never blocks a response: already bounded by the exporter's
 * flush timeout, and any residual failure is swallowed — telemetry must not be
 * able to fail a sign-in. A no-op when no OTLP endpoint is configured, or
 * before the layer has been built for the first time.
 */
export const flushOsnTelemetry = (): Promise<void> =>
  osnRuntime.runPromise(Effect.suspend(() => tracing?.flush ?? Effect.void)).catch(() => undefined);
