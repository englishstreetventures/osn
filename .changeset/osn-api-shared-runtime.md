---
"@osn/api": patch
---

Build the application layer graph once into a shared `ManagedRuntime` instead
of re-providing `DbLive` + the observability layer inside every request's
`Effect.runPromise`. The old per-request pattern restarted and tore down the
whole OpenTelemetry NodeSdk (and opened a fresh SQLite connection) on each
call; the teardown's exporter flush stalled interactive endpoints by ~3s
locally — most visibly the debounced username-availability check
(`GET /handle/:handle`). All nine route factories now run handlers against the
single process-wide runtime (tests wrap their layer in a one-time runtime),
eliminating the per-request rebuild.

Also lightens the handle-availability check itself: it now runs a single-column
`users.handle` existence probe instead of `findProfileByHandle`, which joined
`accounts` to hydrate an email the check discarded.
