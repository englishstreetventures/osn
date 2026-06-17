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

/**
 * Build the per-signal OTLP HTTP endpoint URL from the base endpoint.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the *base* (e.g.
 * `https://otlp.grafana.net/otlp`); the OTLP/HTTP spec routes traces to
 * `<base>/v1/traces` and metrics to `<base>/v1/metrics`. We build the full
 * URL ourselves (and strip a trailing slash so we never emit `//v1/...`)
 * rather than leaning on the exporter's own env fallback — that fallback
 * silently defaults to `http://localhost:4318` when nothing is set, which is
 * exactly the "blind, perpetually-failing export" we want to avoid. Returns
 * `undefined` when no endpoint is configured so the caller can stay a no-op.
 */
export const otlpExporterUrl = (
  endpoint: string | undefined,
  signal: "traces" | "metrics",
): string | undefined => (endpoint ? `${endpoint.replace(/\/+$/, "")}/v1/${signal}` : undefined);

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
