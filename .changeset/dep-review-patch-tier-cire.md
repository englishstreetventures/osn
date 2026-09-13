---
"@cire/api": patch
"@cire/host": patch
"@cire/vendor": patch
---

Take the patch-tier dependency upgrades from the 2026-09-11 review: `jose`
6.2.10 → 6.2.12 in `@cire/api` and `@kobalte/core` 0.13.13 → 0.13.14 in the two
Solid surfaces. Both are bug-fix and internal-refactor releases with no API
change; the Kobalte fixes cover `aria-hidden` during modal handoff,
interact-outside targets across shadow boundaries, and a Combobox filter reset
on blur.

No source change. Full findings are in `DEPS-REVIEW.md`.
