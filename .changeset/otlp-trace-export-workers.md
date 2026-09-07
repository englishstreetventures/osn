---
"@shared/observability": minor
"@osn/api": minor
---

OTLP trace export now works on Cloudflare Workers. Both deployed Workers
(`id.musubi.social`, `api.cireweddings.com`) had `Effect.withSpan` at 177 call
sites and exported nothing: `shared/observability/src/tracing/layer.ts` builds
`NodeSdk.layer(...)`, and `@effect/opentelemetry` ships only `NodeSdk`/`WebSdk`,
neither of which runs on workerd.

New `shared/observability/src/tracing/otlp.ts` — `makeOtlpTracing(config)` —
builds a tracing layer on Effect v4's own `effect/unstable/observability`
(`OtlpTracer` + `OtlpSerialization.layerJson`) over `FetchHttpClient`, so the
whole path is `globalThis.fetch` and has no Node dependency. It returns
`{ layer, flush, enabled }`; the layer is a `Layer.Layer<never>` (the
`Tracer.Tracer` reference is erased from a layer's output type) so it drops
straight into the existing layer graphs and no route factory or `AppDeps`
signature changed.

The background export interval is deliberately pushed 24h out: on workerd no
fiber survives between requests, and a failed background export disables the
exporter — dropping spans — for 60 seconds. `flush` inside `ctx.waitUntil(...)`,
after the response is produced, is the only sound drain, and it drains every
live exporter (a `Layer` is memoized per `MemoMap`, so osn/api's two long-lived
runtimes each hold one). `config.traceSampleRatio` is applied as a head-based,
parent-respecting sampler, matching what the Bun path gets from
`ParentBasedSampler`.

Inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set: the layer is `Layer.empty`,
`flush` is a no-op, and nothing is ever POSTed.

`osn/api`:

- `osnLoggerLayer` now carries the tracer as well as the redacting logger, and
  `build-deps.ts` already merges it into the shared `appRuntime` every route
  runs on — so the route spans are exported without touching a route.
- `runOsn`/`runOsnSync` moved onto a module-scope `ManagedRuntime` (mirroring
  cire/api). `Effect.provide` opens *and closes* a layer's scope per call, which
  with an exporter attached meant building and tearing one down per call.
- `OsnWorkerHandler.fetch` gained an **optional** third `ctx: ExecutionContext`
  parameter, needed for `ctx.waitUntil(flushOsnTelemetry())`. Optional so every
  existing two-argument caller keeps compiling and behaving identically (they
  just skip the flush); a deployed Worker always receives the context.

`shared/observability`:

- `otlpExporterUrl` moved to `src/tracing/url.ts` (re-exported from
  `src/tracing/layer.ts`, so its import path is unchanged) — the workerd
  exporter needs it and must not reach the NodeSdk module.
- `src/tracing/index.ts` is now the workerd-safe barrel and no longer
  re-exports `./layer`; `makeTracingLayer` is still exported from the package
  root, which is Bun-only by construction.
- `tests/tracing/workerd-safety.test.ts` walks the static import graph of every
  subpath the two Workers import and fails on a Node-only dependency, including
  a not-vacuous check that the detector still fires on the Bun-only root barrel.

Traces only. Metric export stays deferred: `src/metrics/factory.ts` builds its
instruments from the raw `@opentelemetry/api` meter rather than Effect's
`Metric`, so `OtlpMetrics` cannot see any of them.

Known limitation, documented in the code: `src/fetch/instrument.ts` and
`src/tracing/propagation.ts` use the raw `@opentelemetry/api` registry, which
nothing bridges to Effect's tracer. An inbound `traceparent` does not become the
parent of these spans and `instrumentedFetch`'s client spans are not their
children, so what is exported is a correctly attributed root span per fiber root
rather than one joined request trace — which is already the shape of the data,
since the repo makes 244 separate `runCire()`/`runOsn()`/`run()` calls.
