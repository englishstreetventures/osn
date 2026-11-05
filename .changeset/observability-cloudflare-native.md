---
"@shared/observability": minor
"@shared/billing": patch
"@shared/email": patch
"@shared/feature-flags": patch
"@shared/turnstile": patch
"@osn/api": patch
"@pulse/api": patch
"@zap/api": patch
---

Workers tracing and logging move to Cloudflare's own observability. `@shared/observability/tracing` exports `WorkersTracingLive` and `installWorkersTracing`: a Worker installs its handler's `ctx.tracing`, and every sampled `Effect.withSpan` then joins the invocation's Workers trace as a custom span, beside Cloudflare's own handler, D1 and `fetch` spans. A mirrored span carries string, number and boolean attributes (a deny-listed key as `[REDACTED]`), marks a failure with `error.type` and error status, never an error message, and records no exception. On workerd the redacting logger now hands Workers Logs each entry as an object, through the console method of its level, so its keys are indexed; the tracer logger sees redacted input on every tier.

Removed, since nothing registered the global OpenTelemetry provider or propagator they needed: `instrumentedFetch` and the `./fetch` subpath (callers use `fetch`, which Cloudflare traces on a Worker), the workerd OTLP exporter `makeOtlpTracing`, the `traceparent` helpers, and the Elysia plugin's server span. `observabilityPlugin()` takes no options. No call between services carries trace context. osn-api installs `ctx.tracing` in `fetch` and `scheduled` and no longer flushes spans. `@shared/feature-flags` and `@shared/turnstile` drop their `@shared/observability` dependency.
