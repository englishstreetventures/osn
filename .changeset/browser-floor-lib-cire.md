---
"@cire/dietary": patch
"@cire/invite-designs": patch
"@cire/theme": patch
"@cire/invites": patch
---

Type-check the packages the guest invite site imports at its browser floor.
`@cire/dietary`, `@cire/invite-designs` and `@cire/theme` state `lib` ES2022
in their own `tsconfig.json` and load no ambient types; `@cire/dietary` and
`@cire/theme` move their tests to `tests/tsconfig.json` (ES2023 and
`bun-types`), and `check` runs both. `@cire/invites` adds
`tests/browser-floor.test.ts`, which walks the site's workspace dependencies and
fails when one states no `lib`, a `lib` or ambient types wider than the site's,
or a `check` that does not cover what it exports. No runtime change.
