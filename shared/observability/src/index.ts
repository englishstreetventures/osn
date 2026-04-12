/**
 * `@shared/observability` — OSN's single source of truth for logging,
 * metrics, and tracing. See `CLAUDE.md` "Observability" section for
 * conventions and the rules every feature must follow.
 */

import { Layer } from "effect";

import { loadConfig, type ConfigOverrides, type ObservabilityConfig } from "./config";
import { makeLoggerLayer } from "./logger/layer";
import { makeTracingLayer } from "./tracing/layer";

export { loadConfig, type ObservabilityConfig, type ConfigOverrides } from "./config";

// Logger
export { makeLoggerLayer, redact, REDACT_KEYS, REDACTION_PLACEHOLDER } from "./logger";

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
  type GraphCloseFriendAction,
  type EventStatus,
} from "./metrics";

// Tracing
export {
  makeTracingLayer,
  NoopTracingLive,
  injectTraceContext,
  extractTraceContext,
  currentTraceId,
  currentSpanId,
} from "./tracing";

// Elysia plugin + health routes
export {
  observabilityPlugin,
  healthRoutes,
  type ObservabilityPluginOptions,
  type HealthRoutesOptions,
} from "./elysia";

// Instrumented fetch
export { instrumentedFetch } from "./fetch";

/**
 * Combined observability layer — logger + tracing + metrics exporter.
 *
 * Provide this once at the top of your application:
 *
 *   const app = new Elysia()
 *     .use(observabilityPlugin({ serviceName: "pulse-api" }))
 *     .use(routes);
 *
 *   Effect.runPromise(
 *     myEffect.pipe(Effect.provide(makeObservabilityLayer(config)))
 *   );
 */
export const makeObservabilityLayer = (config: ObservabilityConfig): Layer.Layer<never> =>
  Layer.mergeAll(makeLoggerLayer(config), makeTracingLayer(config));

/**
 * One-shot bootstrap: load config from env, build the combined layer,
 * and return both. Call at service start:
 *
 *   const { config, layer } = initObservability({ serviceName: "pulse-api" });
 */
export const initObservability = (
  overrides: ConfigOverrides = {},
): { config: ObservabilityConfig; layer: Layer.Layer<never> } => {
  const config = loadConfig(overrides);
  const layer = makeObservabilityLayer(config);
  return { config, layer };
};
