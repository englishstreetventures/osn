---
"@osn/social": patch
---

Declare the frontend build's environment inputs to turbo, and let the deploy jobs reuse the build cache.

`turbo.json`'s `build` task listed no `env`, so `SITE` and every `PUBLIC_*`/`VITE_*` var not covered by turbo's framework inference were absent from the task hash — the dev and production builds of a package hashed identically. The Build & Test job builds with no environment set, so its artifacts are hashed against empty values and a deploy job restoring that cache could be handed them in place of a build carrying the tier's real values.

`build` now declares `"env": ["PUBLIC_*", "VITE_*", "SITE"]`, and the deploy jobs restore the Build & Test cache and build through turbo (`bun run build --filter=@osn/social`) rather than around it.
