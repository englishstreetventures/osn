/**
 * `@shared/observability` — OSN's single source of truth for logging,
 * metrics, and tracing. Conventions and the rules every feature must follow:
 * wiki/shared/observability/overview.md.
 */

import { Layer } from "effect";

import { loadConfig, type ConfigOverrides, type ObservabilityConfig } from "./config";
import { makeLoggerLayer } from "./logger/layer";
import { makeTracingLayer } from "./tracing/layer";

export { loadConfig, type ObservabilityConfig, type ConfigOverrides } from "./config";

// Logger
export {
  makeLoggerLayer,
  PrettyLoggerLive,
  redact,
  REDACT_KEYS,
  REDACTION_PLACEHOLDER,
} from "./logger";

// Metrics — re-export the full public surface.
export {
  createCounter,
  createHistogram,
  createUpDownCounter,
  LATENCY_BUCKETS_SECONDS,
  BYTE_BUCKETS,
  recordHttpRequest,
  httpServerRequests,
  httpServerRequestDuration,
  httpServerActiveRequests,
  type Counter,
  type Histogram,
  type UpDownCounter,
  type CounterOpts,
  type HistogramOpts,
  type HttpAttrs,
  type HttpInFlightAttrs,
  type Result,
  type AuthMethod,
  type RegisterStep,
  type ArcVerifyResult,
  type GraphConnectionAction,
  type GraphBlockAction,
  type EventStatus,
} from "./metrics";

// Tracing
//
// `makeTracingLayer` comes straight from `./tracing/layer` rather than the
// `./tracing` barrel: that barrel is the workerd-safe surface the Workers
// import, so it deliberately does NOT reach the NodeSdk layer. This root barrel
// does, through `makeObservabilityLayer` below; a Worker that imports it keeps
// NodeSdk out of its bundle only because the bundler drops unused exports.
export { makeTracingLayer, otlpExporterUrl } from "./tracing/layer";
export {
  installWorkersTracing,
  NoopTracingLive,
  WorkersTracingLive,
  type WorkersSpan,
  type WorkersTracing,
} from "./tracing";

// Elysia plugin + health routes
export { observabilityPlugin, healthRoutes, type HealthRoutesOptions } from "./elysia";

/**
 * Combined Bun observability layer — the redacting logger + the NodeSdk OTLP
 * layer. Build it once into the application's `ManagedRuntime` at boot, never
 * per request (`wiki/shared/backend-patterns.md`):
 *
 *   const runtime = ManagedRuntime.make(makeObservabilityLayer(config));
 *   const app = new Elysia().use(observabilityPlugin()).use(routes(runtime));
 */
export const makeObservabilityLayer = (config: ObservabilityConfig): Layer.Layer<never> =>
  Layer.mergeAll(makeLoggerLayer(config), makeTracingLayer(config));

/** The config + layer pair handed back by {@link initObservability}. */
export interface ObservabilityBootstrap {
  readonly config: ObservabilityConfig;
  readonly layer: Layer.Layer<never>;
}

/**
 * One-shot bootstrap: load config from env, build the combined layer,
 * and return both. Call at service start:
 *
 *   const { config, layer } = initObservability({ serviceName: "pulse-api" });
 */
export const initObservability = (overrides: ConfigOverrides = {}): ObservabilityBootstrap => {
  const config = loadConfig(overrides);
  const layer = makeObservabilityLayer(config);
  return { config, layer };
};
