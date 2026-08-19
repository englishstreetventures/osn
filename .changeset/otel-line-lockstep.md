---
"@shared/observability": patch
---

Move the whole OpenTelemetry dependency line to 2.10.0 / 0.221.0 in one step, and restore caret ranges.

`@opentelemetry/resources`, `sdk-metrics`, `sdk-trace-base` and `sdk-trace-node` were pinned at `~2.9.0` while the three OTLP exporters and `sdk-logs` sat on the `0.2x` experimental line; the root `@opentelemetry/core` override held `^2.9.0`. The OTel packages only work as a set — a stable package and an experimental one that disagree on `core` produce two copies of the SDK in one process, and the exporter then reads a context the tracer never wrote.

All eight package ranges plus the root override now name the same release train, back on carets so a patch arrives without an edit here.

Installing this collapses the tree to exactly one copy of every `@opentelemetry/*` package. The second sub-tree came from `@effect/opentelemetry`'s undeclared `@opentelemetry/sdk-trace-web` peer, which had locked at 2.6.1 and dragged its own `sdk-trace-base`, `resources` and `semantic-conventions` copies along; re-resolving the lock lifts it to 2.10.0 with the rest. No override was added for it — an override alone does not re-resolve an already-locked auto-installed peer.
