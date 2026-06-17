---
"@shared/observability": minor
---

Wire the OTLP exporter to read its endpoint + headers from env so error/latency
dashboards can be turned on without a code change.

- `makeTracingLayer` now reads `OTEL_EXPORTER_OTLP_ENDPOINT` /
  `OTEL_EXPORTER_OTLP_HEADERS` (via `loadConfig`, unchanged) and, crucially,
  returns a **true** no-op (`NoopTracingLive`) when no endpoint is set —
  previously it built the NodeSdk with an `undefined` exporter URL, which the
  OTLP/HTTP exporter silently resolves to `http://localhost:4318` and then
  spams failing export attempts. Setting the two env vars (plus optional
  `OTEL_SERVICE_NAME`) is now all that's needed to start exporting.
- New pure `otlpExporterUrl(endpoint, signal)` helper builds the per-signal
  `<base>/v1/traces` / `<base>/v1/metrics` URL and strips a trailing slash so
  it never emits `//v1/...`.
- Tests pin both contracts: endpoint-from-env is honoured (real exporter layer,
  auth header read from `OTEL_EXPORTER_OTLP_HEADERS`) and an unset endpoint
  stays a true no-op.

No behaviour change for services that already leave the endpoint unset — they
just stop attempting (and failing) localhost exports.
