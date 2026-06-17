---
"@osn/api": patch
---

Add a workerd-safe, logger-only observability layer to `@osn/api` so the
eventual Cloudflare Workers entry never imports `@effect/opentelemetry/NodeSdk`
(Node-only, won't run on workerd).

- New `osn/api/src/observability.ts` mirrors `cire/api`'s: exports
  `osnLoggerLayer` (built via `makeLoggerLayer(loadConfig({ serviceName: "osn-api" }))`,
  importing only the effect-only `@shared/observability/config` + `/logger`
  subpaths) plus `runOsn` / `runOsnSync` helpers. It deliberately never calls
  `initObservability` / `makeTracingLayer`, which pull the Node OTel SDK. Typed
  `Layer.Layer<never>`, so it is interchangeable with the full layer in the app
  runtime / route signatures.
- `createApp` (`app.ts`) gains an `includeObservabilityPlugin: boolean` deps
  flag. The Elysia `observabilityPlugin` calls `process.hrtime.bigint()` on the
  per-request hot path (start timestamp + duration), which is not available on
  workerd without `nodejs_compat`; the flag lets the Workers path omit it while
  keeping `healthRoutes` + the redacting logger. The Bun path passes `true` —
  no behaviour change.
