---
"@cire/landing": patch
"@cire/invites": patch
"@cire/host": patch
---

Declare the frontend build's environment inputs to turbo, and let the deploy jobs reuse the build cache.

`turbo.json`'s `build` task listed no `env`, so a var that only reaches the build through the environment — `SITE`, and every `PUBLIC_*`/`VITE_*` var not covered by turbo's framework inference — was absent from the task hash. Two builds of the same commit that differ only in those vars hashed identically, so the dev build and the production build of a package were, to turbo, the same task.

The Build & Test job runs a bare `bun run build` with no environment set at all. Its artifacts are therefore hashed against empty values, and once the deploy jobs restore that cache they can be handed those env-less artifacts instead of building with the tier's real values. `SITE` alone is enough to show it: it is not framework-inferred, and it is what Astro renders into `<link rel="canonical">` and `og:url`.

`build` now declares `"env": ["PUBLIC_*", "VITE_*", "SITE"]`, which covers every var the ten frontend build steps set. Each deploy job restores the cache saved by Build & Test — keyed on the lockfile plus the commit SHA, falling back to the lockfile alone — and its build now runs as `bun run build --filter=<pkg>` so it goes through turbo at all; `bun run --cwd <pkg> build` bypassed the cache entirely.
