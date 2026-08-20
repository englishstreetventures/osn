---
"@cire/api": patch
---

Build the Effect runtime once per isolate instead of once per call.

`runCire` / `runCireSync` each constructed a fresh `FiberRuntime` and rebuilt
the logger layer through `Effect.provide` on every invocation. Both now delegate
to a single module-scope `ManagedRuntime`. `Layer.suspend` stays on
`cireLoggerLayer`, so config loading is still deferred to first call — on
workerd `process.env` is unpopulated at module-eval time.
