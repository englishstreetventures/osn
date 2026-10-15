---
"@tools/alchemy": patch
---

Add a dev-only Alchemy probe for the Cire and OSN API infrastructure bindings. It adopts the dev D1 databases and R2 buckets and deploys two token-protected `workers.dev` Workers that check each binding. Before declaring anything, the stack refuses a stage other than dev, a run from outside `tools/alchemy`, any name or id that is not the one `[env.dev]` binds in the committed Worker configs, and live storage settings that differ from its declaration, so adopting never rewrites a dev bucket or database. `bun run destroy` removes the probes without the boundary, storage and token checks and keeps the adopted storage, which the stack refuses to declare as anything but retained.
