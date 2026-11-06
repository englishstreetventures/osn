# @shared/observability

OSN's shared observability primitives — logging, metrics, tracing, and
Elysia instrumentation. The conventions and rules are in
`wiki/shared/observability/overview.md`.

## Quick start

```typescript
import { Elysia } from "elysia";
import { initObservability, observabilityPlugin } from "@shared/observability";

// Bun entries: the redacting logger plus the NodeSdk OTLP layer.
const { layer: observabilityLayer } = initObservability({ serviceName: "pulse-api" });

const app = new Elysia()
  .use(observabilityPlugin())
  .use(routes);

app.listen(3001);
```

## Packages / exports

- `@shared/observability` — the top-level barrel: `initObservability`,
  `makeObservabilityLayer`, `makeTracingLayer` (Bun only: NodeSdk), and the
  most common helpers. A Worker may import `observabilityPlugin` and
  `healthRoutes` from it, as pulse-api and zap-api do; the bundler drops the
  NodeSdk exports it does not use.
- `@shared/observability/config` — env-driven config.
- `@shared/observability/logger` — the redacting loggers: pretty on `local`,
  a structured object to Workers Logs on a deployed Worker, a JSON line on Bun.
- `@shared/observability/metrics` — typed `createCounter`/`createHistogram`,
  shared `attrs` unions, and the HTTP RED metrics used by the Elysia plugin.
- `@shared/observability/tracing` — workerd-safe: `WorkersTracingLive` and
  `installWorkersTracing`, which mirror Effect spans into Cloudflare Workers
  traces. The Bun-only NodeSdk OTLP layer, `makeTracingLayer`, is exported from
  the package root.
- `@shared/observability/elysia` — the `observabilityPlugin` (request id, RED
  metrics) and `healthRoutes` helper.

Outbound HTTP is a plain `fetch`; on a Worker, Cloudflare traces each call.

## Rules (the full version: `wiki/shared/observability/overview.md`)

1. Never call `console.*` in backend code — use `Effect.logInfo/Warn/Error`.
2. Never construct OTel meters/tracers directly — use the typed helpers.
3. Never put unbounded values (userId, requestId, eventId, email, handle)
   in metric attributes.
