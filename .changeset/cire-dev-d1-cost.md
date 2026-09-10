---
"@cire/db": patch
---

The cire dev deploy no longer rebuilds `cire-db-dev` from zero on every merge.
It dropped every table, replayed all 57 migrations from `0001` and re-seeded —
8,007 D1 rows written and about 22,630 read a time, against a free-tier ceiling
of 100,000 written a day shared by every database on the account. Thirteen
merges on 2026-09-09 spent 104,091 and went over it. Almost none of that was the
seed: SQLite rebuilds the whole table for every `ALTER TABLE ... DROP COLUMN`,
and D1 bills that schema churn even against empty tables.

`deploy-cire-api-dev` now applies migrations forward, exactly as production
does, and supersedes queued runs. The full reset → migrate → seed moved to
`.github/workflows/cire-dev-db-rebuild.yml`, nightly and on demand. The chain is
still proved from zero on every pull request by the in-memory T-S1 lockstep
test, and once a night against real D1.

Docs only for this package — the `db:reset:dev` and `db:seed:dev` rows in
`cire/db/README.md` now say when they run. xchromo/osn#979, #980.
