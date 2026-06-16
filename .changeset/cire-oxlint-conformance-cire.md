---
"@cire/organiser": patch
"@cire/web": patch
"@cire/api": patch
---

Bring cire under the OSN oxlint + oxfmt conventions cleanly — cire was the
source of 34 of the repo's 40 oxlint warnings; it is now warning-free under
the shared `oxlintrc.json`.

Lint fixes (behaviour-preserving):

- `unicorn/no-array-sort` — replaced mutating `Array#sort()` with
  non-mutating `Array#toSorted()` in test assertions across `cire/api`
  (`claim`, `rsvp`, `spreadsheet` service + route tests).
- `unicorn/prefer-add-event-listener` — `FileReader`/`script` `on*`
  assignments converted to `addEventListener(...)` in
  `cire/organiser` `ImportPanel`, `cire/web` `PinterestBoard`, and the
  `cire/web` calendar test.
- `unicorn/consistent-function-scoping` — hoisted scope-independent
  helpers (`pad` in `cire/web/calendar`, `tooManyRows` / `cellTooLarge`
  in `cire/api/spreadsheet`) to module scope.
- `no-console` — annotated the `cire/api` local-dev server banner
  (`local.ts`, a Bun shim, not the deployed Worker) with the repo's
  standard `eslint-disable-next-line no-console -- …` justification.

Tooling parity:

- The root `fmt` / `fmt:check` scripts now include `cire` (the `lint`
  script already covered it via `.`), so CI's format check enforces cire
  too. The two cire `astro.config.mjs` files were import-sorted to match.
