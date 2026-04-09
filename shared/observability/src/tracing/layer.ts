// Subpath import (NOT the top-level `@effect/opentelemetry` barrel) — the
// root barrel eagerly re-exports `WebSdk`, which pulls in the optional
// `@opentelemetry/sdk-trace-web` peer dep we don't install. Importing the
// `NodeSdk` subpath directly avoids resolving the web modules.
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { Layer } from "effect";
import type { ObservabilityConfig } from "../config";

/**
 * Build the `@effect/opentelemetry` NodeSdk layer.
 *
 * When `config.otlpEndpoint` is unset, the OTLP exporters still initialise
 * but will fail their exports silently — this is fine for local dev and
 * tests. To make tracing a true no-op in tests, provide `NoopTracingLive`
 * from `./noop.ts` instead.
 */
export const makeTracingLayer = (config: ObservabilityConfig): Layer.Layer<never> =>
  NodeSdk.layer(() => ({
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
        url: config.otlpEndpoint ? `${config.otlpEndpoint}/v1/traces` : undefined,
        headers: config.otlpHeaders,
      }),
    ),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: config.otlpEndpoint ? `${config.otlpEndpoint}/v1/metrics` : undefined,
        headers: config.otlpHeaders,
      }),
      // Flush metrics every 30s in prod, every 5s in dev for faster feedback.
      exportIntervalMillis: config.env === "production" ? 30_000 : 5_000,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSampleRatio),
    }),
  }));
