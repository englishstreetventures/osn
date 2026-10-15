---
"@cire/api": patch
"@cire/db": patch
"@cire/dietary": patch
"@cire/theme": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/vendor": patch
"@cire/ui": patch
"@cire/landing": patch
"@cire/build-tools": patch
"@cire/invite-designs": patch
---

Add Stryker mutation testing: a `test:mutation` script and `stryker.config.mjs` in every cire package with tests, run from the repo root through `scripts/stryker-cire.ts` so the sandbox keeps every relative path a test or config reaches outside the package.
