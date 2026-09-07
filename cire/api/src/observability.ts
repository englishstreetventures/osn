import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { makeOtlpTracing, type OtlpTracing } from "@shared/observability/tracing";
import { Effect, Layer, ManagedRuntime } from "effect";

/**
 * Redacting logger + OTLP trace export for cire/api.
 *
 * ## Logging
 *
 * Replaces Effect's default logger with the shared OSN redacting logger (json
 * in prod / pretty in dev) so every `Effect.log*` message + annotation is run
 * through the secret/PII deny-list (`@shared/observability/logger`'s `redact`)
 * before serialization. Without this layer cire's log calls fall through to
 * Effect's *default* logger and guest PII annotated onto a line — `firstName`,
 * `dietary`, `publicId`, `cire_session`, `osnAccountId`, … — is NOT scrubbed.
 * The deny-list already enumerates every cire field (see `redact.ts`); this
 * layer is what finally applies it.
 *
 * ## Tracing
 *
 * `makeOtlpTracing` sets the `Tracer.Tracer` reference to an OTLP/HTTP exporter
 * built on `effect/unstable/observability` + `globalThis.fetch` — no
 * `@effect/opentelemetry` `NodeSdk`, no `@opentelemetry/sdk-*`, so it runs on
 * workerd. Until this existed, every `Effect.withSpan` in the deployed Worker
 * recorded into Effect's in-memory default tracer and was dropped on the floor.
 *
 * It is **inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**: with no endpoint
 * the tracing layer is `Layer.empty`, {@link flushCireTelemetry} is a no-op and
 * nothing is ever POSTed, so a tier that has not been given a collector behaves
 * exactly as it did before. See `wrangler.toml` for the two vars.
 *
 * **Spans only drain when {@link flushCireTelemetry} is called.** The exporter's
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
 * attributed root span per `runCire` call rather than one joined request trace.
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
 */
let builtLayer: Layer.Layer<never> | undefined;
let tracing: OtlpTracing | undefined;

export const cireLoggerLayer: Layer.Layer<never> = Layer.suspend(() => {
  if (!builtLayer) {
    const config = loadConfig({ serviceName: "cire-api" });
    tracing = makeOtlpTracing(config);
    builtLayer = Layer.merge(makeLoggerLayer(config), tracing.layer);
  }
  return builtLayer;
});

/**
 * Module-scope runtime for `cireLoggerLayer`, built once per isolate instead
 * of once per `runCire`/`runCireSync` call — each call used to pay for a
 * fresh `FiberRuntime` plus `Layer.buildWithScope`, twice over on routes that
 * called either helper more than once. With trace export attached this is no
 * longer only a cost question: `Effect.provide` opens and CLOSES the layer's
 * scope around each run, so a per-call provide would build and tear down a
 * whole OTLP exporter per request.
 *
 * This is safe with the `Layer.suspend` above left intact: `ManagedRuntime.make`
 * only runs `scopeMake` at construction (pure, no env access) — it does not
 * force the layer. The layer itself still builds lazily, on the first
 * `runPromise`/`runSync` below, so `loadConfig` still never runs during module
 * evaluation. Do NOT "simplify" this by inlining `loadConfig` or dropping
 * `Layer.suspend`: on workerd, `nodejs_compat_populate_process_env` only fills
 * `process.env` on first access, and a config read during module load would
 * silently pin every deployed tier to `local` (pretty logs, debug level) with
 * no error at all.
 */
const cireRuntime = ManagedRuntime.make(cireLoggerLayer);

/**
 * Run a fully-resolved cire effect to a Promise with the redacting logger
 * installed. The effect must already have its services (`DbService`,
 * `R2Service`, `AssetsR2Service`, …) provided and its typed errors handled —
 * this only swaps in the logger. Use everywhere instead of bare
 * `Effect.runPromise` so no log line escapes redaction.
 */
export const runCire = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  cireRuntime.runPromise(effect);

/**
 * Synchronous counterpart for the framework error boundary (`app.ts` onError)
 * and the local dev-server banners, where there is no Promise to await.
 */
export const runCireSync = <A, E>(effect: Effect.Effect<A, E, never>): A =>
  cireRuntime.runSync(effect);

/**
 * Drain every span buffered by this isolate to the OTLP collector.
 *
 * Call from `ctx.waitUntil(...)` in the Worker entry, AFTER the response has
 * been produced — every span that request opened has ended by then, and
 * `waitUntil` is what keeps the isolate alive long enough for the POST. This is
 * the ONLY reliable drain on workerd (see the module docstring).
 *
 * Never rejects and never blocks a response: already bounded by the exporter's
 * flush timeout, and any residual failure is swallowed — telemetry must not be
 * able to fail a guest's RSVP. A no-op when no OTLP endpoint is configured, or
 * before the layer has been built for the first time.
 */
export const flushCireTelemetry = (): Promise<void> =>
  cireRuntime
    .runPromise(Effect.suspend(() => tracing?.flush ?? Effect.void))
    .catch(() => undefined);
