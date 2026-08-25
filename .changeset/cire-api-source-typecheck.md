---
"@cire/api": patch
---

Fix every type error in `cire/api`'s own source. The package was never
type-checked — it has no `check` script, so `bun run check` skipped it and
about a hundred errors accumulated behind the gap.

Most were narrow: enum tuples typed as `[string, ...string[]]` instead of the
union they carry, missing fields on a declared return shape, an error union
that omitted a failure the code could actually raise, `Bun.Server` named
without its type argument. Three are worth naming:

- Session rotation had a hand-rolled `.batch()` feature-detect. It now calls
  `commitBatch`, the shared helper the importer and directory writes already
  use, with the same insert-before-delete ordering.
- The organiser write routes drop a `.guard()` wrapper in favour of a second
  `.group()` on the same prefix — the form `organiser-hosts.ts` already uses,
  and the only way to run two gates over one path. The editor and owner gates
  still cover exactly the routes they covered before; `budget.test.ts` pins
  both directions (an editor creates items, an editor gets 403 on the cap).
- The importer's RSVP warning filtered on `status !== "pending"`, but the
  column's enum is `attending | declined | maybe` and it is `NOT NULL` — "no
  answer yet" is the absence of a row. The check was always true, so it is
  gone.
