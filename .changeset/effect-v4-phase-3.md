---
"@shared/observability": minor
"@shared/email": patch
"@osn/api": patch
"@pulse/api": patch
"@zap/api": patch
---

Rebuild the logger for Effect v4, and fix a secret leak in annotation redaction.

`redact()` matches the deny-list against an object's **keys**, and the v3 logger
mapped over each annotation **value** — so it only ever saw a bare scalar with no
key attached and passed it through. `Effect.annotateLogs({ accessToken })`
reached the sink in clear, along with every other deny-listed key, on every tier.
The record is now passed whole.

v4 moved annotations off the logger's `Options` and onto the fiber, so redaction
moves to the output side, wrapping `Logger.formatStructured`. `Logger.layer`
replaces the whole active set, so `Logger.tracerLogger` is listed explicitly —
omitting it drops log-to-span correlation silently. `LogLevel` is now string
literals (`"Warn"`, not v3's `"Warning"`), and the minimum level is a
`References.MinimumLogLevel` service rather than `Logger.minimumLogLevel`.

Adds `PrettyLoggerLive` for the dev-server entrypoints, replacing v3's
`Logger.pretty`. It exists as one export rather than eleven inline
`Logger.layer([…])` arrays so `tracerLogger` has a single place to be got right.

Local output loses ANSI colour for an indented structured rendering:
`consolePretty` is opaque, so there is no seam to redact through it, and one
redaction point covering every tier is the better trade.

**The JSON severity field is now `level`, not `logLevel`.** Grafana queries,
panels and alerts filtering on the old name match nothing and must be updated in
Grafana Cloud by hand.
