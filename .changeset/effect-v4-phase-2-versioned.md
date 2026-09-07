---
"@osn/api": patch
"@osn/client": patch
"@pulse/api": patch
"@zap/api": patch
"@shared/crypto": patch
"@shared/email": patch
"@shared/redis": patch
---

Apply the Effect v4 combinator renames and the Cause/Runtime rework.

Renames resolved from upstream's generated reference: `catchAllDefect` →
`catchDefect`, `catchAllCause` → `catchCause`, `catchAll` → `catch`, `either` →
`result`, `forkDaemon` → `forkDetach`, `zipRight` → `andThen`, `dieMessage` →
`die(new Error(…))`, `Layer.scoped` → `Layer.effect`, `Cause.failureOption` →
`Cause.findErrorOption`. The `Either` module became `Result`, whose variants are
tagged `Success`/`Failure` and carry `success`/`failure` rather than
`right`/`left`.

`Runtime.isFiberFailure` and `FiberFailureCauseId` are gone: v4's runner rejects
with `Cause.squash(cause)`, which is the typed failure itself, so the two
osn-api error-shaping helpers no longer unwrap anything. That changes one thing
on a security path — `Cause.squash` surfaces a *defect* where v3's
`Cause.failureOption` returned `None` — and both helpers now document it.

Adds a test asserting the Redis layer's finalizer runs on scope close. The
`Layer.scoped` → `Layer.effect` rewrite would have leaked connections silently
if the scope had been dropped: it type-checks either way, and nothing covered it.

Second phase of the Effect v4 migration; the tree does not type-check until the
`Schema` work lands.
