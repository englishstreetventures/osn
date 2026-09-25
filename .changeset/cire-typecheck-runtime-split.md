---
"@cire/api": patch
"@cire/invites": patch
---

Type-check shipped source against what its runtime has, and tests against what
they need.

- `@cire/api`: `tsconfig.json` is now the Worker — Workers types only, without
  `bun-types` — so a `Bun.*` call or a `bun:*` import in Worker source fails
  `check`. `src/local.ts` and `src/db/setup.ts`, which only run under Bun, are
  checked with the tests by the new `tests/tsconfig.json`. `check` runs both.
- `@cire/invites`: `tsconfig.json` covers `src/` only, at `lib` ES2022 plus DOM,
  so an ES2023 method such as `toSorted` in guest-site source fails `check`; the
  browser floor (Firefox 114 among it) lacks them. The tests keep ES2023 in the
  new `tests/tsconfig.json`, which `check` runs after `astro check`.

No build output changes.
