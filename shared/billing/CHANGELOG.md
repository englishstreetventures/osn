# @shared/billing

## 0.1.5

### Patch Changes

- 6dbdb99: Drop dependencies no file imports (`motion`, `jose`, `@solidjs/meta`, `@solidjs/testing-library`, `@shared/design-tokens`, `@effect/vitest`, `@opentelemetry/exporter-logs-otlp-http`, and the direct `@vitest/browser` that `@vitest/browser-playwright` already brings in), and stop exporting shared symbols used only inside their own file. No behaviour changes.
- Updated dependencies [6dbdb99]
  - @shared/observability@0.20.1

## 0.1.4

### Patch Changes

- 08d9eaf: Workers tracing and logging move to Cloudflare's own observability. `@shared/observability/tracing` exports `WorkersTracingLive` and `installWorkersTracing`: a Worker installs its handler's `ctx.tracing`, and every sampled `Effect.withSpan` then joins the invocation's Workers trace as a custom span, beside Cloudflare's own handler, D1 and `fetch` spans. A mirrored span carries string, number and boolean attributes (a deny-listed key as `[REDACTED]`), marks a failure with `error.type` and error status, never an error message, and records no exception. On workerd the redacting logger now hands Workers Logs each entry as an object, through the console method of its level, so its keys are indexed, and lists no tracer logger there; elsewhere the tracer logger sees redacted input. Every logger scrubs a logged cause's failures and defects before rendering it, the mirror matches a deny-listed key on its last dotted segment too, and `loadConfig` parses `OTEL_EXPORTER_OTLP_HEADERS` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

  Removed, since nothing registered the global OpenTelemetry provider or propagator they needed: `instrumentedFetch` and the `./fetch` subpath (callers use `fetch`, which Cloudflare traces on a Worker), the workerd OTLP exporter `makeOtlpTracing`, the `traceparent` helpers, and the Elysia plugin's server span. `observabilityPlugin()` takes no options. No call between services carries trace context. osn-api installs `ctx.tracing` in `fetch` and `scheduled`, no longer flushes spans, and runs its cron sweeps on `runOsn`. `@shared/feature-flags` and `@shared/turnstile` drop their `@shared/observability` dependency.

- Updated dependencies [08d9eaf]
  - @shared/observability@0.20.0

## 0.1.3

### Patch Changes

- Updated dependencies [e6b19ae]
  - @shared/observability@0.19.5

## 0.1.2

### Patch Changes

- Updated dependencies [a56d73d]
  - @shared/observability@0.19.4

## 0.1.1

### Patch Changes

- Updated dependencies [ad20023]
  - @shared/observability@0.19.3

## 0.1.0

### Minor Changes

- 432200d: Add `@shared/billing`: code-defined plans and features, Stripe subscriptions over `fetch` (API version `2025-03-31.basil`, no SDK), feature access from the database, and a webhook that verifies, claims, re-fetches and applies access under a per-customer lease. `status()` exposes the paid period an invoice confirmed, so a trial or an unpaid renewal never counts as paid. `syncPlans` writes the plans to Stripe and is a dry run unless told to apply. Tables come from `createBillingSqliteSchema({ prefix })` for D1 and bun:sqlite; the consumer owns the migrations.

  `@shared/observability` redacts the billing provider's `secretKey` and `webhookSecret`, and the Stripe customer fields that invoices, Checkout sessions and customer objects carry: `customer_details`, `customer_address`, `customer_email`, `customer_name`, `customer_phone`, `customer_shipping`, `customer_tax_ids`, `address` and `tax_ids`.

### Patch Changes

- Updated dependencies [432200d]
  - @shared/observability@0.19.2
