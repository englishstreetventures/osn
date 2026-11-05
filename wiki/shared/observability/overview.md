---
title: Observability Overview
aliases: [observability, OpenTelemetry, OTel, Grafana, Workers Observability]
tags: [observability, platform]
status: active
related:
  - "[[logging]]"
  - "[[tracing]]"
  - "[[metrics]]"
  - "[[feature-checklist]]"
  - "[[observability-setup]]"
packages: ["@shared/observability"]
last-reviewed: 2026-11-05
---

# Observability Overview

The deployed Workers use **Cloudflare's own observability**: Workers traces record every invocation (handler, D1, KV, R2, Durable Objects, outbound `fetch`), the application's `Effect.withSpan` spans join that trace as custom spans, and the redacting logger writes each log line to Workers Logs as a structured object. Nothing is exported from a Worker and nothing needs flushing. Bun processes (`src/local.ts`) can export Effect spans over OTLP to **Grafana Cloud** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Frontend observability is **Grafana Faro**. All plumbing lives in `@shared/observability` -- no other package should import `@opentelemetry/*` directly.

> **Workers.** Each Worker's `[observability]` block (on dev, its Alchemy
> stack) decides what Cloudflare keeps. Cire keeps invocation records off
> because its request paths carry the wedding slug. Native traces are enabled in
> the local Wrangler configs without URL redaction, and on every dev API Worker
> and the dev guest site; on dev only zap-api keeps query strings. Production
> traces are enabled on the Cire guest Worker, including its existing slug
> paths; production API Workers keep native traces disabled while path-bearing
> URLs are reviewed, so their mirrored Effect spans are discarded there too.
> Logs and traces are in the Cloudflare dashboard under Workers & Pages →
> *worker* → Observability. No call between services carries trace context
> ([[tracing#Trace context across services]]). **Metrics reach no exporter on
> any runtime**: the factory instruments use the global `@opentelemetry/api`
> meter, which nothing registers (englishstreetventures/osn#501). See
> [[free-tier-limits]] (Monitoring), [[tracing]], [[logging]] and
> [[observability-setup]].

## Package layout

```
shared/observability/
  src/
    config.ts              # env -> typed config
    logger/                # Effect loggers + redaction (pretty, Workers Logs object, JSON line)
    tracing/
      workers.ts           # Effect spans mirrored into Workers traces (WorkersTracingLive)
      layer.ts             # Bun only: @effect/opentelemetry NodeSdk OTLP layer
    metrics/
      factory.ts           # typed createCounter / createHistogram / createUpDownCounter
      attrs.ts             # shared attribute string-literal unions (Result, AuthMethod, ...)
    elysia/plugin.ts       # request ID, RED metrics, in-flight gauge (no span)
    elysia/health.ts       # /health, /ready
```

Outbound HTTP is a plain `fetch`. On a Worker, Cloudflare records each call as a `fetch` span in the request's trace.

## The three golden rules

1. **Never call `console.*` in backend code.** Use `Effect.logInfo` / `Effect.logWarn` / `Effect.logError`. `makeLoggerLayer` swaps in the redacting logger: pretty on `local`, a structured object to Workers Logs on a deployed Worker, a JSON line on Bun in a deployed tier. Effect's console is the one sink. See [[logging]] for the full rules.

2. **Never construct OTel meters/tracers directly.** Use the typed helpers from `@shared/observability/metrics`. This is a convention checked in review, not a lint rule: a raw `metrics.getMeter(...)` call lints and type-checks clean, so the reviewer has to look for one. See [[metrics]] for the factory API and naming conventions.

3. **Never put unbounded values in metric attributes.** No `userId`, no `requestId`, no `eventId`, no email, no handle. Those belong in traces (spans) or logs (annotations), never metrics. See [[metrics]] for the cardinality rules.

## Bun exporter wiring (env-driven; true no-op when unset)

Only the Bun entries read these; no Worker exports anything.

- **`OTEL_EXPORTER_OTLP_ENDPOINT` unset** → `makeTracingLayer` returns a **true
  `NoopTracingLive`**: no exporter, and no failing retries against
  `http://localhost:4318` (the local default).
- **`OTEL_EXPORTER_OTLP_ENDPOINT` set** → OTLP export of Effect spans. The
  per-signal URL is built by a pure `otlpExporterUrl(endpoint, signal)` helper
  (`<base>/v1/traces`, `<base>/v1/metrics`; trailing slash stripped so it never
  emits `//v1/...`).
- **`OTEL_EXPORTER_OTLP_HEADERS`** carries the auth header
  (`Authorization=Basic <base64(instance:token)>`) and is a **secret**.
  `OTEL_SERVICE_NAME` is the optional third var. See [[observability-setup]] and
  [[tracing#Bun: OTLP export]].

## Pillar pages

| Pillar | Page | Key concern |
|--------|------|-------------|
| Logging | [[logging]] | Structured Effect logs, redaction, log levels |
| Tracing | [[tracing]] | Workers traces, mirrored Effect spans, span naming, no cross-service trace context |
| Metrics | [[metrics]] | Typed counters/histograms, naming, cardinality enforcement |

## Feature checklist

Every feature PR should pass the [[feature-checklist]] before merge -- it covers logs, traces, metrics, and dashboard follow-ups.

## What stays out of scope (for now)

- **Alerting rules and dashboards** -- separate post-instrumentation work
- **Self-hosted collector** -- Bun processes use the Grafana Cloud OTLP endpoint directly
- **Continuous profiling** (pyroscope)
- **WebSocket per-message spans** -- deferred to Zap M1
- **Log-based metrics** -- straight counters/histograms only
