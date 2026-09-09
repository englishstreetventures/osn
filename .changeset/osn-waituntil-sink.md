---
"@osn/api": patch
---

Route every detached background send through a per-request sink that the Worker
entry hands to `ExecutionContext.waitUntil`.

On workerd a promise never passed to `waitUntil` may not run once the response
is returned, so all seven `Effect.forkDetach` notification sites could silently
drop their outbound email on the deployed Worker. It diverges only there — on
the Bun dev server the fibre completes, so no unit test, local run or
`wrangler deploy --dry-run` could observe it.
