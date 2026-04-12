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
finding-ids: [S-H18, S-H20]
last-reviewed: 2026-04-12
---

# Tracing

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

## Trace propagation

**Propagate trace context across services via the shared `fetch` wrapper.** Any outbound HTTP from our code goes through `instrumentedFetch` from `@shared/observability/fetch` -- it injects `traceparent` + (if configured) the ARC token header. Never use raw `fetch()` for service-to-service calls.

## Inbound traceparent trust boundary (S-H18)

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

WebSocket spans are **out of scope for the initial rollout** -- deferred to Zap M1. Per-message spans will be added when `@zap/api` lands.
