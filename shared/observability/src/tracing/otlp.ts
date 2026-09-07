import { Duration, Effect, Layer, Tracer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import type { ObservabilityConfig } from "../config";
import { NoopTracingLive } from "./noop";
import { otlpExporterUrl } from "./url";

/**
 * OTLP/HTTP trace export that runs on Cloudflare Workers (workerd).
 *
 * ## Why this exists next to `./layer.ts`
 *
 * `./layer.ts` builds `NodeSdk.layer(...)`, which needs `@opentelemetry/sdk-*`
 * and Node built-ins — it runs on Bun and nowhere else. `@effect/opentelemetry`
 * ships only `NodeSdk` and `WebSdk`, so neither of the two DEPLOYED Workers
 * (`id.musubi.social`, `api.cireweddings.com`) could export a single span:
 * every `Effect.withSpan` in them recorded into the default in-memory tracer
 * and was dropped.
 *
 * Effect v4 ships its own OTLP client under `effect/unstable/observability`,
 * built on `HttpClient` rather than the OTel JS SDK. Paired with
 * `FetchHttpClient` (which is just `globalThis.fetch`) it has no Node
 * dependency at all, so it runs on workerd. Nothing here imports
 * `@effect/opentelemetry`, `@opentelemetry/sdk-*` or any Node built-in — that
 * carve-out is what lets `osn/api` and `cire/api` adopt tracing without
 * dragging the Node SDK into their Worker bundles, and it is asserted by
 * `tests/tracing/workerd-safety.test.ts`.
 *
 * ## Draining is explicit, because the background interval is not reliable here
 *
 * The exporter batches and owns a forked fiber that exports every
 * `exportInterval`. On workerd **no fiber survives between requests**: once a
 * request's I/O context closes, the isolate is frozen, timers do not fire, and
 * an export that a later request happens to resume is not attributable to a
 * live context. Worse, the exporter treats ANY export failure as a signal to
 * disable itself for 60 seconds (`disabledUntil` in `OtlpExporter.make`) —
 * during which it also DROPS pushed spans — so one cancelled background export
 * silently blinds the Worker for a minute.
 *
 * So on the workerd path the background loop is pushed out of the way
 * ({@link WORKERD_EXPORT_INTERVAL}) and the only sound drain is an explicit
 * {@link OtlpTracing.flush} inside `ctx.waitUntil(...)`, after the response has
 * been produced and every span has ended. Both Worker entries do exactly that.
 *
 * ## Known limitation: this tree is not joined to the `@opentelemetry/api` tree
 *
 * `../fetch/instrument.ts` and `./propagation.ts` use the raw
 * `@opentelemetry/api` globals (`trace.getTracer`, `propagation.inject` /
 * `extract`). Those are a different tracer registry from Effect's, and nothing
 * bridges them: an inbound `traceparent` does NOT become the parent of the
 * spans exported here, and the client spans `instrumentedFetch` creates are not
 * children of them. What is exported is therefore a correctly-attributed ROOT
 * span per `Effect.withSpan` root, not one joined end-to-end request trace.
 * That is already the shape of the data — the repo makes 244 separate
 * `runCire()` / `runOsn()` / `run()` calls across its routes, so a "request" is
 * several fiber roots regardless. Bridging the two registries is a separate
 * piece of work; do not assume a joined trace when reading this data.
 */

/**
 * How long the exporter's background export loop sleeps before its first tick.
 *
 * Deliberately longer than any isolate lives. See the module docstring: a
 * background export on workerd can be cancelled mid-flight, and a cancelled
 * export disables the exporter (and drops spans) for 60s, which would also
 * swallow the explicit flush that is the whole drain strategy. Overridable via
 * {@link OtlpTracingOptions.exportInterval} for a runtime where the background
 * loop IS reliable.
 */
export const WORKERD_EXPORT_INTERVAL = Duration.hours(24);

/** Default ceiling on one `flush`, so a hung collector cannot pin `waitUntil`. */
export const DEFAULT_FLUSH_TIMEOUT = Duration.seconds(3);

/**
 * Safety valve only. Spans are drained per request, so the buffer should never
 * approach this; reaching it forks an unawaited export, which is the failure
 * mode described in the module docstring. Set high enough that ordinary traffic
 * never trips it, low enough that a runaway loop cannot exhaust isolate memory.
 */
const DEFAULT_MAX_BATCH_SIZE = 2048;

export interface OtlpTracingOptions {
  /** Background export interval. Defaults to {@link WORKERD_EXPORT_INTERVAL}. */
  readonly exportInterval?: Duration.Input | undefined;
  /** Buffered-span ceiling. Defaults to 2048. */
  readonly maxBatchSize?: number | undefined;
  /** Ceiling on one {@link OtlpTracing.flush}. Defaults to 3 seconds. */
  readonly flushTimeout?: Duration.Input | undefined;
}

export interface OtlpTracing {
  /**
   * The tracing layer to merge into the application layer graph.
   *
   * Sets the `Tracer.Tracer` context reference, which is why the type is
   * `Layer.Layer<never>` and not `Layer.Layer<Tracer.Tracer>`: references
   * always have a default, so they are erased from a layer's output type. That
   * keeps it drop-in wherever `Layer.Layer<never>` is already threaded (route
   * factories, `makeAppRunner`, `AppDeps.observabilityLayer`).
   */
  readonly layer: Layer.Layer<never>;
  /**
   * Drain every buffered span to the collector, now.
   *
   * Requires nothing (`R = never`) and cannot fail, so it can be run through
   * any runtime — including one that did not build {@link layer}. Already
   * bounded by `flushTimeout`; a timeout is not an error, the spans simply stay
   * buffered for the next drain. A no-op when the layer has never been built or
   * when no endpoint is configured.
   */
  readonly flush: Effect.Effect<void>;
  /** `false` when no OTLP endpoint is configured — nothing is exported. */
  readonly enabled: boolean;
}

/**
 * Apply `config.traceSampleRatio` as a head-based, parent-respecting sampler.
 *
 * `OtlpTracer` has no sampler option and Effect v4's core tracer samples by
 * trace LEVEL, not ratio — so without this a Worker would export 100% of spans
 * while `OSN_TRACE_SAMPLE_RATIO` (0.1 by default in production) said otherwise,
 * which is both a lie and a free-tier cost. The decision is taken on ROOT spans
 * only; Effect's span constructor already forces a child to `sampled: false`
 * when its parent is unsampled, so one decision per trace propagates down.
 *
 * Matches what the Bun path gets from
 * `ParentBasedSampler({ root: TraceIdRatioBasedSampler })`, except the draw is
 * `Math.random()` rather than a hash of the trace id. That only matters for a
 * trace split across services, and these spans are per-call roots anyway (see
 * the module docstring).
 */
const withRatioSampler = (ratio: number, tracer: Tracer.Tracer): Tracer.Tracer =>
  ratio >= 1
    ? tracer
    : Tracer.make({
        ...tracer,
        span: (options) =>
          tracer.span(
            options.root && options.sampled && Math.random() >= ratio
              ? { ...options, sampled: false }
              : options,
          ),
      });

/**
 * Build the workerd-safe OTLP trace-export layer plus its explicit drain.
 *
 * Inert when `config.otlpEndpoint` is unset: the layer is `NoopTracingLive`
 * (`Layer.empty`), `flush` is `Effect.void`, and NOTHING is ever posted. A
 * Worker with no OTLP endpoint configured therefore behaves exactly as it did
 * before this existed — no crash, no request-path cost, no failing background
 * export. Turning export on is `OTEL_EXPORTER_OTLP_ENDPOINT` +
 * `OTEL_EXPORTER_OTLP_HEADERS` (both parsed and validated by `loadConfig`,
 * which rejects CRLF/control characters in header values before they reach the
 * HTTP layer).
 *
 * Traces only. Metrics are deliberately NOT exported here: `../metrics/factory`
 * builds its instruments from the raw `@opentelemetry/api` meter, not Effect's
 * `Metric`, so `OtlpMetrics` cannot see a single one of them and wiring it
 * would export an empty payload forever.
 */
export const makeOtlpTracing = (
  config: ObservabilityConfig,
  options: OtlpTracingOptions = {},
): OtlpTracing => {
  const url = otlpExporterUrl(config.otlpEndpoint, "traces");
  if (!url) return { layer: NoopTracingLive, flush: Effect.void, enabled: false };

  /**
   * Every LIVE exporter built from {@link layer}, so `flush` drains all of
   * them.
   *
   * There is normally exactly one. But a `Layer` is memoized per `MemoMap`, and
   * each `ManagedRuntime` gets its own — so a service that builds the same
   * layer into two long-lived runtimes (osn/api does: the module-level runtime
   * in `observability.ts` and the shared `appRuntime` in `build-deps.ts`) gets
   * two exporters, and only one of them holds the spans. Capturing a single
   * flusher into a `let` would silently drain the empty one. Registration is
   * scoped, so a build that is torn down (`Effect.provide` closes its layer
   * scope when the effect finishes) removes itself and the set stays bounded.
   */
  const liveFlushers = new Set<{ readonly flush: Effect.Effect<void> }>();

  const acquireTracer = Effect.gen(function* () {
    const tracer = yield* OtlpTracer.make({
      url,
      headers: config.otlpHeaders,
      resource: {
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        attributes: {
          "service.namespace": config.serviceNamespace,
          "service.instance.id": config.serviceInstanceId,
          "deployment.environment": config.env,
        },
      },
      exportInterval: options.exportInterval ?? WORKERD_EXPORT_INTERVAL,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    });

    const flusher = yield* OtlpExporter.Flusher;
    liveFlushers.add(flusher);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        liveFlushers.delete(flusher);
      }),
    );

    return withRatioSampler(config.traceSampleRatio, tracer);
  });

  // `Layer.provide` (not `provideMerge`) for all three dependencies: the
  // Flusher, the JSON serializer and the fetch-backed HttpClient are this
  // layer's private plumbing and must not leak into the application context.
  // The `Tracer.Tracer` reference the layer sets DOES survive, because
  // `Layer.effect` on a reference puts it in this layer's own output.
  const layer: Layer.Layer<never> = Layer.effect(Tracer.Tracer)(acquireTracer).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );

  const flushTimeout = options.flushTimeout ?? DEFAULT_FLUSH_TIMEOUT;

  const flush: Effect.Effect<void> = Effect.suspend(() =>
    liveFlushers.size === 0
      ? Effect.void
      : Effect.forEach(liveFlushers, (flusher) => flusher.flush, {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.timeoutOption(flushTimeout), Effect.asVoid),
  );

  return { layer, flush, enabled: true };
};
