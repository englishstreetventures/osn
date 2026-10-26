---
"@cire/api": patch
"@cire/build-tools": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@cire/vendor": patch
"@tools/e2e": patch
"@tools/oxlint-house": patch
"@tools/pr-metrics": patch
"@tools/stryker": patch
---

Move to TypeScript 7.1 (`typescript@7.1.0-beta`). The cire Astro sites drop `astro check` and `@astrojs/check` and type-check with `tsc -p . --runExternalCode` and `@astrojs/ts-content-mapper`, which also checks the shared `@cire/ui` privacy notice that `astro check` never reached; `astro` moves to 7.4.2 and `@astrojs/cloudflare` to 14.4.2, the adapter release built for it; the Astro builds in CI and deploy jobs now run on Node 24, since astro 7.4 needs Node 22.23.4 or later. The tests that used TypeScript 6's compiler API use TypeScript 7.1's API, and Stryker runs without it.
