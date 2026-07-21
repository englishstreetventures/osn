---
"@shared/observability": patch
---

Dependency review: bump `@opentelemetry/exporter-{logs,metrics,trace}-otlp-http` and `@opentelemetry/sdk-logs` `^0.219.0` → `^0.220.0` (the 0.220.0 breaking change to `BatchLogRecordProcessor`/`SimpleLogRecordProcessor` constructors is not used in this codebase; stable companion packages move to 2.9.0 within the existing `^2.8.0` ranges).
