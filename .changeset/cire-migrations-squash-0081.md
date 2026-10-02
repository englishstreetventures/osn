---
"@cire/db": patch
"@cire/api": patch
---

Squash cire D1 migrations `0058`–`0081` into the baseline,
`cire/db/migrations/0001_initial.sql`, which now builds the whole schema in 96
schema statements instead of the 150 the live chain had grown to. The baseline
is generated from a replay of the archived chain, so a fresh database gets the
same tables, columns in the same order, and index names as a database that ran
every migration; `ddl-lockstep.test.ts` and the D1 tier both check it. The 24
files moved to `cire/db/migrations-archive/`, which now holds `0001`–`0081`.
New migrations start at `0082`.

The baseline keeps its name, so every deployed database skips it. That is
only right on a database that already applied the whole archived chain, so
`db:push` and `db:migrate:local|dev|prod` now run `scripts/cire-db-migrate.ts`.
It reads the target's `d1_migrations` ledger first and refuses, naming the
missing files, a database that stopped part-way through the archive, where
wrangler would otherwise skip the rest without a word. A ledger holding only
the baseline's name is checked against the schema itself, so a database an
older baseline built is refused too. It applies with the wrangler version
`@cire/api` pins.

**Production must apply `0062`–`0081` before this merges.** Its last cire-api
deploy ran on 2026-09-21, when the chain ended at `0061`. Until a pre-squash
deploy run brings it level, the production cire-api deploy stops at the ledger
check, before any migration runs or the Worker deploys.

The D1 cost line in `scripts/d1-migration-cost-budgets.txt` moves to 5184 rows
(192 schema statements), twice the new baseline.
