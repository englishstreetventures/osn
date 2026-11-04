---
title: Tracing
aliases: [tracing rules, spans, Effect.withSpan, traceparent]
tags: [observability, tracing]
status: active
related:
  - "[[overview]]"
  - "[[logging]]"
  - "[[metrics]]"
  - "[[arc-tokens]]"
packages: ["@shared/observability"]
last-reviewed: 2026-11-04
---
# Tracing

## Native Workers traces

Production Workers configure Cloudflare's automatic traces in Wrangler; dev
Workers take theirs from their Alchemy stack
([[infrastructure-as-code#Production observability]]). The local Wrangler
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
trace there. The production guest deploy runs it again on the adapter's
generated `dist/server/wrangler.json` before `wrangler deploy`.

A fetch handler span records the full URL and path, the user agent, the
visitor's country, city and timezone, their network (ASN) and
`Accept-Language`; an outbound fetch span records the URL, its query and the
response status. Neither records a body, a cookie or the client IP
([spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/),
read 2026-10-15). Cloudflare keeps traces for seven days.

The workerd-safe application spans below are separate from native Workers
traces. `osn-api` and `cire-api` export them through an OTLP/HTTP exporter when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set ([[cire-workerd]]); without it they are
inert.

## Span creation

Wrap every service-level function in `Effect.withSpan("<domain>.<operation>")`.

Examples:
- `events.create`
- `auth.register.complete`
- `graph.connection.accept`
- `arc.token.verify`

## Span naming convention

Span names are **hierarchical** and **snake_case**. Dots separate layers; underscores separate words. Match the [[metrics]] naming convention so dashboards can correlate on shared prefixes.

## Route-level spans

**Do not create spans at route level** -- the Elysia plugin already creates a span per request with `http.*` attributes. Creating a second span inside the handler is redundant; add service spans inside the Effect pipeline instead.

**Mount the plugin before the routes.** It lifts its hooks to the app that mounts it (`.as("global")` in [plugin.ts](../../../shared/observability/src/elysia/plugin.ts)), and Elysia attaches a hook only to routes registered after it. A route registered before `.use(observabilityPlugin(...))` still runs `onRequest`, so its span starts and the in-flight gauge rises, but the span never ends and the gauge never falls.

**The span names the matched route template (`http.route`), never the URL path or query**, since paths hold handles and profile ids and queries carry codes and tokens.

**An error span carries the error's name and Elysia's error code, never its message or stack.** `onError` records an exception event whose type is the error's name and whose message is the code (`UNKNOWN`, `VALIDATION`, `NOT_FOUND`, or a thrown error's own `code`), and sets the span status to that code; a response of 500 or more then sets the status message to `HTTP <status>`. A message is free text that `redact()` cannot clean, since it scrubs object keys, and Elysia's validation errors carry the rejected input in theirs.

## Exporter: env-driven, true no-op when unset (PR #129)

`makeTracingLayer` reads `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`
from env:

- **Endpoint unset** → a **true `NoopTracingLive`** layer. No NodeSdk, no exporter,
  no perpetually-failing background export. (Previously an `undefined` exporter URL
  was silently resolved to `http://localhost:4318` and spammed failed exports — that
  is gone.)
- **Endpoint set** → real OTLP export to `<endpoint>/v1/traces` (built by the pure
  `otlpExporterUrl` helper, trailing slash stripped). `OTEL_EXPORTER_OTLP_HEADERS`
  supplies the auth header and is a **secret**.

Set the two env vars (plus the optional `OTEL_SERVICE_NAME`) to start exporting spans.
See [[overview]] and [[observability-setup]] for the full env list.

## Trace propagation

**Propagate trace context across services via the shared `fetch` wrapper.** Any outbound HTTP from our code goes through `instrumentedFetch` from `@shared/observability/fetch` -- it injects `traceparent` + (if configured) the ARC token header. Never use raw `fetch()` for service-to-service calls.

## Inbound trace context

**Inbound trace context becomes a span link, never the parent.** The Elysia plugin starts every server span as a root (`root: true` in [plugin.ts](../../../shared/observability/src/elysia/plugin.ts)), so the span gets a trace id of its own and the registered sampler makes its own sampling decision, whatever the caller sends. A well-formed inbound `traceparent` is attached to the span as a link when the span starts, carrying the caller's trace id, span id and sampled bit and nothing else. The plugin never parses `tracestate` or `baggage`, and a malformed `traceparent` adds no link.

No header changes this, `Authorization: ARC ...` included: the plugin runs before any route checks credentials, so nothing it sees proves who sent a request. The link is the caller's unverified claim, a pointer to the caller's trace and never proof that a first-party service sent the request. A trace viewer shows a cross-service call as two traces joined by a link. Samplers must not read links: one that did would hand the caller the sampling decision.

The plugin starts its spans on the global OpenTelemetry tracer and extracts through the global propagator. No service registers either, so today these spans record nothing and no link is made; the rules above hold from the day one is registered. [plugin.test.ts](../../../shared/observability/tests/plugin.test.ts) registers both to test them.

## Elysia hook limitation (known)

Elysia's `onRequest -> handler -> onAfterResponse` hooks run as separate invocations, not inside a single enclosing callback. OTel's `context.with(ctx, fn)` scope only lives for the duration of `fn`, so there is no way to make a single OTel `Context` active across the hook -> handler boundary via hooks alone.

**Consequences:**
- `trace.getActiveSpan()` inside a synchronous handler does NOT see the server span
- Effect service spans created via `Effect.withSpan` become root spans rather than children of the HTTP request

**What still connects:** across services, `instrumentedFetch` sends `traceparent` and the receiving plugin links it to its server span ([[#Inbound trace context]]), once a global tracer provider and propagator are registered.

## WebSocket spans

WebSocket spans are **out of scope for the initial rollout** -- deferred to Zap M1. Add per-message spans when `@zap/api` ships.
