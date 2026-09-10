---
"@cire/db": patch
"@cire/api": patch
---

Squash cire D1 migrations `0001`–`0057` into a single baseline,
`cire/db/migrations/0001_initial.sql`.

Building a database from the 57-file chain cost 8,007 D1 rows written and about
22,630 read, against a free-tier ceiling of 100,000 written a day across every
database on the account. Almost none of it was data: SQLite rebuilds the whole
table for each `ALTER TABLE ... DROP COLUMN`, and D1 bills that schema churn
even when the table is empty. The baseline creates the same shape in 68
statements.

Production is untouched. `wrangler d1 migrations apply` skips any file already
named in the target's `d1_migrations` ledger, production's ledger holds
`0001_initial.sql`, and `d1 migrations list --env production` still reports
nothing to apply. The filename is therefore load-bearing and is pinned by a
test.

The originals moved to `cire/db/migrations-archive/`, outside `migrations_dir`,
because six tests replay them to prove what they did to real rows. Those tests
now read the archive. New migrations start at `0058`.

xchromo/osn#981.
