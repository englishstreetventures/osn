---
"@shared/observability": patch
---

The Bun tracing layer samples root traces at `OSN_TRACE_SAMPLE_RATIO`. `makeTracingLayer` passed its sampler where `NodeSdk.layer` never reads it, so every root trace was sampled whatever the ratio; the sampler now sits under `tracerConfig`. The standard `OTEL_TRACES_SAMPLER` variables, which the provider's fallback read, are no longer consulted.
