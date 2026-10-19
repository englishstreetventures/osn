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
last-reviewed: 2026-10-20
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

## Inbound traceparent trust boundary

**Inbound `traceparent` is only trusted from ARC-authenticated callers.** The Elysia plugin extracts upstream trace context when -- and only when -- the request presents `Authorization: ARC ...`. Anonymous/public requests start fresh root spans to prevent external attackers from forcing sampling decisions or injecting chosen trace IDs into our internal traces.

## Elysia hook limitation (known)

Elysia's `onRequest -> handler -> onAfterResponse` hooks run as separate invocations, not inside a single enclosing callback. OTel's `context.with(ctx, fn)` scope only lives for the duration of `fn`, so there is no way to make a single OTel `Context` active across the hook -> handler boundary via hooks alone.

**Consequences:**
- `trace.getActiveSpan()` inside a synchronous handler does NOT see the server span
- Effect service spans created via `Effect.withSpan` become root spans rather than children of the HTTP request

**Mitigations:**
- Distributed tracing across services still works (inbound/outbound `traceparent` propagation is unaffected)
- For handlers that explicitly want child spans, use `getRequestContext(request)` + `context.with(...)` as an escape hatch

## WebSocket spans

WebSocket spans are **out of scope for the initial rollout** -- deferred to Zap M1. Add per-message spans when `@zap/api` ships.
