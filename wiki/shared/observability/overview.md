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
last-reviewed: 2026-10-23
---

# Observability Overview

OSN uses **OpenTelemetry end-to-end**, shipped to **Grafana Cloud** (free tier: 10k active series, 50 GB/mo logs, 50 GB/mo traces, 14-day rolling retention). Frontend observability via **Grafana Faro** (same OTLP endpoint, no Sentry). All plumbing lives in `@shared/observability` -- no other package should import `@opentelemetry/*` directly.

> **Workers.** The Node OpenTelemetry SDK is unavailable on workerd. `osn-api`
> and `cire-api` instead use an optional Effect-based OTLP/HTTP span exporter;
> it sends spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured and is inert
> otherwise. Application metrics still need a workerd export path.
> Cloudflare Workers Logs are configured in each Worker's `[observability]`
> block. Cire keeps invocation records off because existing request paths carry
> the wedding slug. Free-plan logs currently retain three days and are visible
> in the Cloudflare dashboard under Workers & Pages → *worker* → Observability.
> Native Workers traces are enabled in the local Wrangler configs without URL
> redaction, and on every dev API Worker and the dev guest site; on dev only
> zap-api keeps query strings. Production traces are enabled on the Cire guest Worker, including
> its existing slug paths. New guest links use fixed paths with the slug in the
> redacted query string. Production API Workers keep native traces disabled
> while path-bearing URLs are reviewed.
> Grafana Cloud remains the destination for Bun-hosted telemetry and configured
> workerd OTLP spans. See [[free-tier-limits]] (Monitoring)
> and [[observability-setup]].

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

1. **Never call `console.*` in backend code.** Use `Effect.logInfo` / `Effect.logWarn` / `Effect.logError`. `ObservabilityLive` swaps the logger for `Logger.jsonLogger` in prod and `Logger.prettyLogger()` in dev. See [[logging]] for the full rules.

2. **Never construct OTel meters/tracers directly.** Use the typed helpers from `@shared/observability/metrics`. This is a convention checked in review, not a lint rule: a raw `metrics.getMeter(...)` call lints and type-checks clean, so the reviewer has to look for one. See [[metrics]] for the factory API and naming conventions.

3. **Never put unbounded values in metric attributes.** No `userId`, no `requestId`, no `eventId`, no email, no handle. Those belong in traces (spans) or logs (annotations), never metrics. See [[metrics]] for the cardinality rules.

## Exporter wiring (env-driven; true no-op when unset)

The OTLP exporter reads its destination from env, so you can turn dashboards on
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
