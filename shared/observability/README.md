# @shared/observability

OSN's shared observability primitives — logging, metrics, tracing, and
Elysia instrumentation. See the "Observability" section in `CLAUDE.md`
for the full conventions and rules.

## Quick start

```typescript
import { Elysia } from "elysia";
import { initObservability, observabilityPlugin, ObservabilityLive } from "@shared/observability";

await initObservability({ serviceName: "pulse-api", serviceVersion: "0.4.4" });

const app = new Elysia()
  .use(observabilityPlugin({ serviceName: "pulse-api" }))
  .use(routes);

app.listen(3001);
```

## Packages / exports

- `@shared/observability` — top-level barrel with `initObservability`,
  `ObservabilityLive`, and the most common helpers.
- `@shared/observability/config` — env-driven config.
- `@shared/observability/logger` — Effect `Logger.json` + redaction.
- `@shared/observability/metrics` — typed `createCounter`/`createHistogram`,
  shared `attrs` unions, and the HTTP RED metrics used by the Elysia plugin.
- `@shared/observability/tracing` — `@effect/opentelemetry` NodeSdk layer +
  W3C trace context helpers.
- `@shared/observability/elysia` — the `observabilityPlugin` and
  `healthRoutes` helper.
- `@shared/observability/fetch` — `instrumentedFetch` for outbound S2S
  calls (propagates `traceparent`).

## Rules (see CLAUDE.md for the full version)

1. Never call `console.*` in backend code — use `Effect.logInfo/Warn/Error`.
2. Never construct OTel meters/tracers directly — use the typed helpers.
3. Never put unbounded values (userId, requestId, eventId, email, handle)
   in metric attributes.
