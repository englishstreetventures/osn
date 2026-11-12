---
title: Tracing
aliases: [tracing rules, spans, Effect.withSpan, Workers traces]
tags: [observability, tracing]
status: active
related:
  - "[[overview]]"
  - "[[logging]]"
  - "[[metrics]]"
  - "[[arc-tokens]]"
  - "[[free-tier-limits]]"
packages: ["@shared/observability"]
last-reviewed: 2026-11-12
---
# Tracing

The deployed Workers are traced by Cloudflare: Workers traces record every invocation, and the application's own `Effect.withSpan` spans join the same trace as custom spans. No Worker registers an OpenTelemetry provider or exports spans itself. Bun processes (`src/local.ts`) export Effect spans over OTLP when an endpoint is set ([[#Bun: OTLP export]]).

## Native Workers traces

Production and dev Workers take Cloudflare's automatic traces from their Alchemy
stack; each production Worker's `[env.production]` Wrangler block mirrors its
production setting ([[infrastructure-as-code#Production observability]]). The local Wrangler
configs trace requests without URL redaction. On dev every API Worker and the
guest site trace every request: osn-api, cire-api and cire-invites remove query
strings, zap-api keeps them, and the static sites trace nothing. Staging and
production tiers remove query strings from request URLs in Cloudflare logs and
native traces.
The production Cire guest Worker traces both existing `/<slug>` links and new
`/cire/invite?slug=…` and `/cire/registry?slug=…` links. Existing slug paths and
their outbound API URLs appear in native traces. New links use fixed paths and
resolve their invite through a fixed API URL with the slug in the request body.
Production API Workers keep native traces disabled while path values and
outbound URLs are reviewed. Cloudflare records URLs before application code
runs, so the shared logger's `redact()` cannot change native span attributes.

[`scripts/check-trace-redaction.ts`](../../../scripts/check-trace-redaction.ts)
holds that line. CI runs it on the committed configs: every staging and
production tier must set `redact_query_string = true`, and no API Worker may
trace there. The production stacks deploy from their declarations, which each
stack's parity test holds to those configs, and `apiWorkerProps()` refuses an
unredacted production Worker on its own.

Cloudflare records, with no code: the fetch, scheduled and queue handler spans;
every outbound `fetch`; D1 (`d1_first`, `d1_run`, `d1_all`, `d1_raw`,
`d1_batch`, `d1_exec`, with the query text and rows read and written); KV; R2;
Durable Object calls, storage and alarms; RPC between Workers; the Cache API;
Queues; Email; rate-limit bindings
([spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/),
read 2026-11-05). A fetch handler span records the full URL and path, the user
agent, the visitor's country, city and timezone, their network (ASN) and
`Accept-Language`; an outbound fetch span records the URL, its query and the
response status. Neither records a body, a cookie or the client IP. Cloudflare
keeps traces for seven days
([Observability pricing](https://developers.cloudflare.com/observability/pricing/)),
and samples them at `observability.traces.head_sampling_rate`
([Workers traces](https://developers.cloudflare.com/workers/observability/traces/)).

## Effect spans in Workers traces

`WorkersTracingLive` (`@shared/observability/tracing`,
[workers.ts](../../../shared/observability/src/tracing/workers.ts)) mirrors each
sampled `Effect.withSpan` into the invocation's trace through the Workers
custom-span API, `tracing.startSpan`
([custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/),
read 2026-11-05). osn-api's `osnLoggerLayer` and cire-api's `cireLoggerLayer`
carry it, so every route on `appRuntime` or `runCire` and every cron sweep is
covered. Each Worker's `fetch` and `scheduled` call
`installWorkersTracing(ctx.tracing)` first; any invocation's `ctx.tracing`
records into whichever invocation is current, so concurrent requests each keep
their spans in their own trace. zap-api and pulse-api do not mirror their Effect
spans yet: englishstreetventures/osn#2000.

What a mirrored span carries, and what it does not:

- **Placement.** A direct child of the invocation's handler span, beside the
  native D1 and `fetch` spans. `startSpan` returns a span that is never active,
  so the Effect tree's own nesting is not kept; the timeline still shows it.
- **Attributes.** String, number and boolean values only; an object-valued
  attribute is dropped. A key on the logger's deny-list
  ([[logging#Redaction]]), whole or by its last dotted segment (`user.email`),
  carries `[REDACTED]`.
- **Failure.** `error.type` set to the error's `_tag` (an `Error`'s `name` for a
  defect) and the span's status set to error. Never the message, which is free
  text the deny-list cannot clean. Never `recordException` either: on
  `wrangler dev` each call also writes an error-level log line, so a failure
  passing up through nested spans would write several. wrangler's local
  collector shows the error status as nothing; the `error.type` attribute is
  what it shows.
- **Not carried.** Span events, which hold the tracer logger's copy of each log
  line, and links. The Workers span has no API for either.
- **Sampling.** Cloudflare's. `OSN_TRACE_SAMPLE_RATIO` governs only the Bun
  path.

Limits and edges:

- Span names are cut at 64 bytes and each span holds about 64 KB of attributes
  ([custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)).
  The API is in beta and Cloudflare may rename spans and attributes.
- A runtime whose `ctx.tracing` has no `startSpan` (workerd 1.20260730, which
  Miniflare 4.20260730 in the D1 tests runs, is one) installs nothing, and so
  does an invocation without a context; until the next invocation installs
  again, the isolate's spans stay in-process. Every deployed invocation carries
  one.
- An Effect fiber that another request's work resumes (one request completing a
  `Deferred` another request waits on) runs in that request's I/O context.
  There workerd refuses a console call with "Cannot perform I/O on behalf of a
  different request", so a log line from that fiber fails, and a span it opens
  did not reach the trace; the mirror swallows any refusal. A request that
  awaits a promise another request resolves either never resumes or fails the
  same way. workerd applies the rule to every kind of I/O, not only telemetry.

  *Measured 2026-11-05 — `wrangler dev` (wrangler 4.149.0, workerd 1.20261006.1), two overlapping requests, traces on and off, `console.log` and `console.info`.*

**Cost.** Ingestion counts where traces are on: local, dev and the production
guest site, never a production API Worker (above). From 2026-12-01 traces and
logs share one ingestion allowance, 0.5 GB a day on Workers Free
([[free-tier-limits#Monitoring]]). CPU: a mirrored span costs 16–29 µs on
local workerd, with observability on or off.

*Measured 2026-11-05 — `wrangler dev` (wrangler 4.149.0, workerd 1.20261006.1),
one request opening 1,000 spans through `ctx.tracing.startSpan`, timed between
two awaited fetches: 16–29 ms. Production not measured.*

[`tests/wrangler/workers-observability.e2e.ts`](../../../shared/observability/tests/wrangler/workers-observability.e2e.ts)
runs the mirror and the Workers Logs logger on real workerd and reads both back
([[testing-patterns#The end-to-end suite]]).

## Span creation

Wrap every service-level function in `Effect.withSpan("<domain>.<operation>")`.

Examples:
- `events.create`
- `auth.register.complete`
- `graph.connection.accept`
- `arc.token.verify`

## Span naming convention

Span names are **hierarchical** and **snake_case**. Dots separate layers; underscores separate words. Match the [[metrics]] naming convention so dashboards can correlate on shared prefixes. Keep names under 64 bytes, where Workers traces cut them.

## Route-level spans

**Do not create spans at route level.** On Workers the handler span is Cloudflare's, with the request's method, URL and status; add service spans inside the Effect pipeline instead. The Elysia plugin (`observabilityPlugin`) starts no span: it echoes a sanitised `x-request-id` and records the RED metrics.

**Mount the plugin before the routes.** It lifts its hooks to the app that mounts it (`.as("global")` in [plugin.ts](../../../shared/observability/src/elysia/plugin.ts)), and Elysia attaches a hook only to routes registered after it. A route registered before `.use(observabilityPlugin())` still runs `onRequest`, so the in-flight gauge rises, but it never falls.

**Metric labels name the matched route template (`http.route`), never the URL path or query**, since paths hold handles and profile ids and queries carry codes and tokens.

## Trace context across services

**No call between services carries trace context.** Cloudflare does not propagate it: "Trace context is also not propagated automatically" ([custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/), read 2026-11-05), and "trace IDs are not propagated to services outside of Cloudflare" ([known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)). The services call each other over public HTTPS, not service bindings. No service writes a `traceparent` from its span ids either; that is this repository's choice, since a span's `traceFlags` does not say whether the request is sampled, which Cloudflare warns about. So each service's trace stands alone.

**Nor is an inbound `traceparent` adopted.** On `wrangler dev` a handler span starts a trace of its own when the caller sends a forged `traceparent`, so no caller chooses another service's trace id or sampling decision; the E2E test above checks it on every run. Cloudflare lists propagation as coming, with no date, so that test is the one to fail first when it lands.

What is left for following a call from one service to the next: the caller's `fetch` span (its URL path, status and time) against the callee's handler span for that path at that time. osn-api's Workers entry, and the Elysia plugin on pulse-api and zap-api, echo a well-formed inbound `x-request-id`, but no caller sends one and no log line or span records it.

## Bun: OTLP export

On Bun, `initObservability()` (osn, pulse and zap `src/local.ts`) builds `makeTracingLayer`, `@effect/opentelemetry`'s `NodeSdk` with an OTLP/HTTP exporter. It exports the process's Effect spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is set:

- **Endpoint unset** → a **true `NoopTracingLive`** layer. No NodeSdk, no exporter, no perpetually-failing background export.
- **Endpoint set** → real OTLP export to `<endpoint>/v1/traces` (built by the pure `otlpExporterUrl` helper, trailing slash stripped). `OTEL_EXPORTER_OTLP_HEADERS` supplies the auth header and is a **secret**.
- A root trace is sampled at `OSN_TRACE_SAMPLE_RATIO` (0.1 by default in production, 1.0 elsewhere), and a child follows its parent.

cire-api's Bun dev server builds no NodeSdk layer, so it exports nothing; run `bunx wrangler dev` and read wrangler's local explorer to see its traces. See [[overview]] and [[observability-setup]] for the env list.

## WebSocket spans

WebSocket spans are **out of scope for the initial rollout** -- deferred to Zap M1. Add per-message spans when `@zap/api` ships.
