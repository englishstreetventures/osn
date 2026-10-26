---
"@cire/api": patch
"@cire/build-tools": patch
"@cire/db": patch
"@cire/dietary": patch
"@cire/host": patch
"@cire/infra": patch
"@cire/invite-designs": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/theme": patch
"@cire/ui": patch
"@cire/vendor": patch
"@tools/e2e": patch
"@tools/oxlint-house": patch
"@tools/pr-metrics": patch
"@tools/stryker": patch
---

Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. The Astro packages keep `astro check`. Cold `turbo typecheck` across the workspaces takes 15.8 s, down from 42.3 s with `tsc`, and a deliberate type error still fails with exit 1.

Three test files are reformatted by `bun fmt`, which the repo now uses in place of oxfmt.
