---
"@shared/observability": patch
"@zap/api": patch
---

Redact the pretty logger, stop a deployed Worker from using it, and stop
`redact` from killing the fiber that logged.

`layer.ts` claimed `Logger.consolePretty()` was "opaque, so there is no seam to
redact through", and the v4 migration gave up ANSI colour on the `local` tier on
that basis. The claim was false. v4 exposes the entry on the **input** side:
`Logger.Options` carries `message`, and the pretty logger reads annotations as
`fiber.getRef(References.CurrentLogAnnotations)`. Shadowing both and delegating
to an untouched `consolePretty` redacts it while Effect keeps ownership of
colour, log spans, `LogToStderr`, `ConsoleRef` and the fiber id.

So `PrettyLoggerLive` is redacted now, and `local` gets colour back — the
colour-for-redaction trade was never a real trade. The unredacted-logger
category is gone from the codebase entirely, which is the point: no call site
can pick the wrong one.

`redact` gained an `Error` branch returning a real `Error` with scrubbed own
properties, so the stack traces the pretty logger exists for survive the scrub.
Nothing changes on the JSON path, where `formatStructured` has already flattened
values before `redact` sees them.

`redact` also no longer **throws** on cyclic input; it returns `[Circular]`. It
runs inside the logger on every deployed tier, so `Effect.logError("x", err)`
with a looping `cause` chain was killing the fiber that logged. A logger must
not be able to do that. The primitive fast path is untouched.

`zap/api/src/index.ts` is a deployed Worker (`main = "src/index.ts"`, route
`zap.cireweddings.com`) and was the only non-dev-server consumer of
`PrettyLoggerLive` — so its two registration log lines had no redaction, no
minimum log level, no span correlation, and emitted multi-line ANSI into Workers
Logs, which is exactly what the `dev` tier is denied the pretty logger for. It
now builds `makeLoggerLayer` from the workerd-safe subpaths, memoised per
isolate. No secret was reaching those lines today — all four reachable throw
sites in `registerWithOsnApi` are benign — the problem was the shape.

shared/observability: 92 -> 101. zap/api: 179, unchanged.
