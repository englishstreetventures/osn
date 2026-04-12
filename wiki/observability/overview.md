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
last-reviewed: 2026-04-12
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
