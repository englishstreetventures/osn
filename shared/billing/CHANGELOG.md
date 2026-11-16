# @shared/billing

## 0.1.18

### Patch Changes

- 4426307: The package's tests drop five cases other tests already cover, shorten four waits on the real clock, and make the 64 KB webhook body test check the refusal reason.

## 0.1.17

### Patch Changes

- 5347e06: Dependency bumps that cleared the waiting rules on 2026-11-15: `effect` and the
  `@effect/*` packages 4.1.4 (with the root overrides for `@effect/sql-d1` and
  `@effect/platform-node-shared`), `astro` 7.4.11, `@astrojs/solid-js` 7.1.5,
  `@astrojs/cloudflare` 14.4.7, `@elysiajs/openapi` 1.4.17 (escapes OpenAPI
  values in the Swagger UI and Scalar pages), `@opentelemetry/*` 2.12.1 and
  0.223.1, `jose` 6.2.17, `turbo` 2.11.11, `portless` 0.15.13, `nitro`
  3.0.261103-rc, `@solidjs/start` 2.1.0, `wrangler` 4.156.1 (with the root override of `@cloudflare/vite-plugin` raised to 1.67.0, the release that pins that Wrangler, so the tree carries one Wrangler), `oxlint` and
  `@oxlint/plugins` 1.90.0, `lucide-solid` 1.66.0, `@shadcn/lint` 0.2.3, and
  `three` and `@types/three` 0.187.0.

  Effect's tracers now leave a successful span's status Unset rather than Ok.

  `mime` stays on 4.0.7 in `@shared/infra`: Wrangler 4.156.1 still bundles 4.0.7,
  and the asset upload types every file the way that copy does.

  `@shared/db-utils`: `@effect/sql-d1` 4.1.3 stopped making a D1 client a subtype of `SqlClient`, so `commitEffectWrites` takes a handle whose `$client` is either.

- Updated dependencies [5347e06]
  - @shared/db-utils@0.9.4
  - @shared/observability@0.26.1

## 0.1.16

### Patch Changes

- Updated dependencies [05ca2d8]
  - @shared/observability@0.26.0

## 0.1.15

### Patch Changes

- Updated dependencies [582649a]
  - @shared/observability@0.25.1

## 0.1.14

### Patch Changes

- Updated dependencies [3437d4a]
  - @shared/observability@0.25.0

## 0.1.13

### Patch Changes

- Updated dependencies [c34015f]
  - @shared/observability@0.24.2

## 0.1.12

### Patch Changes

- Updated dependencies [0d8f467]
  - @shared/observability@0.24.1

## 0.1.11

### Patch Changes

- Updated dependencies [45c409b]
  - @shared/observability@0.24.0

## 0.1.10

### Patch Changes

- Updated dependencies [f052448]
  - @shared/observability@0.23.0

## 0.1.9

### Patch Changes

- Updated dependencies [0821963]
  - @shared/observability@0.22.0

## 0.1.8

### Patch Changes

- Updated dependencies [cbd32bd]
- Updated dependencies [9d193fe]
  - @shared/observability@0.21.0

## 0.1.7

### Patch Changes

- Updated dependencies [64cb5fa]
  - @shared/observability@0.20.3

## 0.1.6

### Patch Changes

- c687234: Every workspace that uses Effect runs `effect` 4.1.2, with `@effect/platform-bun`,
  `@effect/platform-node`, `@effect/sql-d1`, `@effect/opentelemetry` and
  `@effect/vitest` at 4.1.2 and the root overrides for
  `@effect/platform-node-shared` and `@effect/sql-d1` with them. The stacks run
  `alchemy` and `@alchemy.run/cloudflare` 2.0.0-beta.85, which loads on Effect
  4.1 unpatched; the provider's patch, carried to beta.85, keeps the D1 import
  the stacks ran on beta.84 and the content types Wrangler uploads assets with.
  beta.85 deploys state store version 8, which beta.84 cannot use, so a tier's
  store cannot go back once it is upgraded.

  The production plan guard reads beta.85's console lines
  (`[hh:mm:ss.mmm] INFO: …`), and `messageOf()` reads no logfmt record.
  `@shared/infra`'s tests hold the AWS SDK the provider installs,
  `@distilled.cloud/aws`, to listing and aborting an R2 bucket's multipart
  uploads, and run both under Bun. `RETIRED_STAGING_HOSTS` is gone from
  `@shared/infra`, and `domainRefusals()` takes `(changes, unflip)`: a site's
  Worker gives up only its current spare host without an `unflip` naming the
  site.

- Updated dependencies [c687234]
  - @shared/db-utils@0.9.3
  - @shared/observability@0.20.2

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
