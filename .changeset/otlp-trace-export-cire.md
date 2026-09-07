---
"@cire/api": patch
---

OTLP trace export on the deployed `api.cireweddings.com` Worker. `cireLoggerLayer`
now merges `makeOtlpTracing(config).layer` alongside the redacting logger, so the
`Effect.withSpan` call sites on the ~244 `runCire()` roots finally reach a
collector instead of Effect's in-memory default tracer. `cireRuntime` is
unchanged — it was already the single long-lived runtime every route runs on,
which is exactly where the tracer needs to be.

The Worker `fetch` now awaits the dispatch and schedules
`ctx.waitUntil(flushCireTelemetry())` afterwards. That explicit drain is the only
sound one on workerd: no fiber survives between requests, so the exporter's
background interval either never fires or fires with no live context, and a
failed background export disables the exporter — dropping spans — for 60 seconds.
The flush never rejects and never blocks a guest's response.

Inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (see `wrangler.toml`): no
layer, no flush, nothing POSTed, behaviour identical to before. Traces only —
metric export stays deferred, because `@shared/observability` builds its
instruments from the raw `@opentelemetry/api` meter, which Effect's `OtlpMetrics`
cannot see.
