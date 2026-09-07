// Subpath import (NOT the top-level `@effect/opentelemetry` barrel) — the
// root barrel eagerly re-exports `WebSdk`, which pulls in the optional
// `@opentelemetry/sdk-trace-web` peer dep we don't install. Importing the
// `NodeSdk` subpath directly avoids resolving the web modules.
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type { Layer } from "effect";

import type { ObservabilityConfig } from "../config";
import { NoopTracingLive } from "./noop";
import { otlpExporterUrl } from "./url";

// `otlpExporterUrl` is shared with the workerd-safe `./otlp.ts` exporter and so
// lives in `./url.ts`, which imports nothing. Re-exported here because this is
// the path it has always been imported from.
export { otlpExporterUrl } from "./url";

/**
 * Build the `@effect/opentelemetry` NodeSdk layer.
 *
 * The exporter endpoint + headers come from env (`OTEL_EXPORTER_OTLP_ENDPOINT`
 * / `OTEL_EXPORTER_OTLP_HEADERS`, parsed into `config` by `loadConfig`). When
 * `config.otlpEndpoint` is unset we return a true no-op layer
 * (`NoopTracingLive`) — NOT the NodeSdk with an undefined URL, which would
 * fall back to `http://localhost:4318` and spam failing export attempts.
 * Setting the two env vars is all that's needed to turn export on.
 */
export const makeTracingLayer = (config: ObservabilityConfig): Layer.Layer<never> => {
  if (!config.otlpEndpoint) return NoopTracingLive;

  return NodeSdk.layer(() => ({
    resource: {
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
      attributes: {
        "service.namespace": config.serviceNamespace,
        "service.instance.id": config.serviceInstanceId,
        "deployment.environment": config.env,
      },
    },
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: otlpExporterUrl(config.otlpEndpoint, "traces"),
        headers: config.otlpHeaders,
      }),
    ),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: otlpExporterUrl(config.otlpEndpoint, "metrics"),
        headers: config.otlpHeaders,
      }),
      // Flush metrics every 30s in prod, every 5s in dev for faster feedback.
      exportIntervalMillis: config.env === "production" ? 30_000 : 5_000,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSampleRatio),
    }),
  }));
};
