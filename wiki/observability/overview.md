---
title: Observability Overview
aliases: [observability, OpenTelemetry, OTel, Grafana]
tags: [observability, platform]
status: active
related:
  - "[[logging]]"
  - "[[tracing]]"
  - "[[metrics]]"
  - "[[feature-checklist]]"
  - "[[observability-setup]]"
packages: ["@shared/observability"]
last-reviewed: 2026-06-17
---

# Observability Overview

OSN uses **OpenTelemetry end-to-end**, shipped to **Grafana Cloud** (free tier: 10k active series, 50 GB/mo logs, 50 GB/mo traces, 14-day rolling retention). Frontend observability via **Grafana Faro** (same OTLP endpoint, no Sentry). All plumbing lives in `@shared/observability` -- no other package should import `@opentelemetry/*` directly.

## Package layout

```
shared/observability/
  src/
    config.ts              # env -> typed config
    logger/                # Effect Logger.json + redaction (no pino)
    tracing/               # @effect/opentelemetry NodeSdk layer
    metrics/
      factory.ts           # typed createCounter / createHistogram / createUpDownCounter
      attrs.ts             # shared attribute string-literal unions (Result, AuthMethod, ...)
    elysia/plugin.ts       # request ID, spans, access log, RED metrics, /health, /ready
    fetch/instrument.ts    # outbound fetch wrapper: injects W3C traceparent + ARC token preserved
```

## The three golden rules

1. **Never call `console.*` in backend code.** Use `Effect.logInfo` / `Effect.logWarn` / `Effect.logError`. The logger is automatically replaced with `Logger.jsonLogger` in prod and `Logger.prettyLogger()` in dev via `ObservabilityLive`. See [[logging]] for the full rules.

2. **Never construct OTel meters/tracers directly.** Use the typed helpers from `@shared/observability/metrics`. Raw `metrics.getMeter(...)` calls are banned (lint rule enforces this). See [[metrics]] for the factory API and naming conventions.

3. **Never put unbounded values in metric attributes.** No `userId`, no `requestId`, no `eventId`, no email, no handle. Those belong in traces (spans) or logs (annotations), never metrics. See [[metrics]] for the cardinality rules.

## Exporter wiring (env-driven; true no-op when unset)

The OTLP exporter reads its destination from env, so dashboards can be turned on
without a code change (PR #129):

- **`OTEL_EXPORTER_OTLP_ENDPOINT` unset** → `makeTracingLayer` returns a **true
  `NoopTracingLive`**. Previously it built the NodeSdk with an `undefined` exporter
  URL, which the OTLP/HTTP exporter silently resolved to `http://localhost:4318`
  and then spammed perpetually-failing export attempts. There is now no exporter and
  no failing retries when the endpoint is absent (the local/dev default).
- **`OTEL_EXPORTER_OTLP_ENDPOINT` set** → real OTLP export. The per-signal URL is
  built by a pure `otlpExporterUrl(endpoint, signal)` helper (`<base>/v1/traces`,
  `<base>/v1/metrics`; trailing slash stripped so it never emits `//v1/...`).
- **`OTEL_EXPORTER_OTLP_HEADERS`** carries the auth header
  (`Authorization=Basic <base64(instance:token)>`) and is a **secret** — set it via
  the deploy environment / `wrangler secret put`, never commit it. `OTEL_SERVICE_NAME`
  is the optional third var. See [[observability-setup]] and [[tracing]].

## Pillar pages

| Pillar | Page | Key concern |
|--------|------|-------------|
| Logging | [[logging]] | Structured Effect logs, redaction, log levels |
| Tracing | [[tracing]] | Spans, trace propagation, Elysia hook limitations |
| Metrics | [[metrics]] | Typed counters/histograms, naming, cardinality enforcement |

## Feature checklist

Every feature PR should pass the [[feature-checklist]] before merge -- it covers logs, traces, metrics, and dashboard follow-ups.

## What stays out of scope (for now)

- **Alerting rules and dashboards** -- separate post-instrumentation work
- **Self-hosted collector** -- use Grafana Cloud OTLP endpoint directly
- **Continuous profiling** (pyroscope)
- **WebSocket per-message spans** -- deferred to Zap M1
- **Log-based metrics** -- straight counters/histograms only
