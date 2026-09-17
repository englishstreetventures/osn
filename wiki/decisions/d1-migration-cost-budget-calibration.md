---
title: "Pricing a migration chain at 27 D1 rows per schema write"
tags:
  - decision
  - d1
  - ops
  - build
related:
  - "[[bundle-size-guards]]"
  - "[[free-tier-limits]]"
  - "[[dev-environment]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-17
---

# Pricing a migration chain at 27 D1 rows per schema write

`scripts/guard-d1-migration-cost.ts` prices a migration chain **offline** —
replaying every `.sql` into in-memory `bun:sqlite`, counting schema writes, and
multiplying by a constant — rather than asking D1 what a rebuild cost. The
constant, `ROWS_WRITTEN_PER_SCHEMA_WRITE`, is **27**.

The two rules any guard with a threshold obeys are in [[bundle-size-guards]];
this page is only about how the number was arrived at and what it does not
cover.

## Why the guard exists

The cire dev deploy crossed a hard free-tier ceiling by growing, not by
breaking. Every `ALTER TABLE ... DROP COLUMN` added to the chain made each
from-zero rebuild a little more expensive, and on 2026-09-09 thirteen merges
spent **104,091 D1 rows written** against a limit of 100,000 a day across the
whole account (xchromo/osn#979). No commit was wrong and no test failed.

## Why offline, and why a constant at all

A from-zero rebuild runs against empty tables, so nearly all of what it spends
is schema churn: SQLite rebuilds the whole table for every dropped column, and
D1 bills that against no data at all. Each schema statement therefore costs a
roughly fixed number of rows whatever the table holds — which is the claim the
constant rests on, and the reason a count of statements can stand in for a
bill.

Counting schema writes is exact. One per statement that changes the schema, two
for a statement that makes SQLite rebuild a whole table (`ALTER TABLE ... DROP
COLUMN`). Rows that a data statement in a migration actually writes are counted
exactly too, from SQLite's own `changes`.

## The evidence for 27

**One hard anchor.** One `ALTER TABLE ... DROP COLUMN` on
`wedding_invite_customisations`, against a table with no rows in it, cost 54 D1
rows written — two schema writes at 27 apiece.

*measured 2026-09-10:*
`bunx wrangler d1 insights cire-db-dev --time-period=7d --sort-by=writes --limit=200`

**One soft anchor, agreeing within about 20% and no better.** The 57-file chain
squashed by xchromo/osn#984 measures 269 schema writes. Its rebuild cost 8,007
D1 rows written in total (unverified in the guard — taken from
[[free-tier-limits]] and the xchromo/osn#979 investigation), but that total
covers drop, replay *and* seed, so it only bounds the chain once the seed is
subtracted, and the seed's cost is what is not known precisely:

- `cire/db/seed/dev-seed.sql` inserts 2,063 tuples, and D1 bills index entries
  as rows written too, so the seed cost **at least** that. The chain is then at
  most 8,007 − 2,063 = 5,944, or **22.1 rows per schema write**.

  *measured 2026-09-10: replay `cire/db/migrations/0001_initial.sql` then
  `cire/db/seed/dev-seed.sql` into `bun:sqlite` and sum SQLite's `changes`.*

- The often-quoted "89% schema, 11% seed" split does **not** settle it. That is
  the split within the 200 *heaviest* queries — 56,852 rows written across
  those 200, against roughly 409,000 on the database over the week's rebuild
  days — not a share of one rebuild. The seed cost it implies, 881 rows, is
  below the seed's own floor of 2,063, which is the tell that the sample
  over-represents schema statements. Neither sampling figure has been
  re-derived.

So the constant sits somewhere in a **22 to 27 band**, and the guard takes 27:
the top of the band, the only directly measured point, and the safe side, since
over-stating what a rebuild costs is the error that does not lose a day's quota.

## What the uncertainty touches

The schema-write count is exact — counted, not modelled — and it is what a
reader should trust. Every **row** figure the guard prints, and every "replays a
day" derived from one, carries the 22-27 band: read them as indicative, and as
pessimistic by up to about a fifth rather than optimistic. The line the guard
enforces is printed in schema writes beside the budget for exactly that reason,
so the threshold can be read without trusting the constant at all.

Changing the constant changes every printed row figure and every headroom
figure, so it is a re-baseline of the same weight as a budget row.

## What is not in the number

- **The seed.** The guard prices the chain, because the chain is what a pull
  request changes. A full dev rebuild drops, replays and *then* seeds, and the
  seed's 2,063 tuples come on top.
- **The `d1_migrations` ledger insert** that `wrangler d1 migrations apply`
  makes per file is inside the constant rather than modelled, since the
  calibration chain paid for 57 of them. That over-charges a short chain
  slightly — again on the safe side.
- **The read ceiling.** It is 5,000,000 a day against 100,000 written, and the
  rebuild that spent 8% of the write allowance spent 0.5% of the read one. Writes
  are the binding constraint, and a second threshold would only be a second
  number to keep true.

## What would make this worth revisiting

- A second hard anchor from `wrangler d1 insights` that lands outside the 22-27
  band, or a Cloudflare-documented figure for what a schema statement bills.
- The seed's own cost being measured on D1 rather than floored from tuple count,
  which would tighten the soft anchor enough to move the constant off the top of
  the band.
- Reads becoming the binding constraint, which would need a guard of its own
  rather than a recalibration of this one.

Raising a budget row is not the first answer when this guard fires: squashing
the chain into a fresh baseline puts the number back **down**, which is what
xchromo/osn#984 did. See [[bundle-size-guards]].
