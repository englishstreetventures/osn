---
"@cire/api": patch
---

T-S1 (platform PR 0): mechanical enforcement of the three-way DDL lockstep
contract. New `src/db/ddl-lockstep.test.ts` replays the full
`cire/db/migrations/*.sql` chain (filename order, exactly as
`wrangler d1 migrations apply` runs it) into one in-memory DB, the `setup.ts`
test DDL into another, and diffs a normalised structural snapshot of each
(columns, foreign keys, indexes, checks — ignoring cosmetic differences like
column order, index names, and drizzle-kit's `PRIMARY KEY NOT NULL` spelling);
the Drizzle schema (`@cire/db`) is introspected via `getTableConfig` and
diffed against the migrated shape too. A schema change to any one surface now
fails the suite until all three agree.

The test immediately surfaced and fixes four real drifts in the `setup.ts`
mirror (tests were passing against a shape production D1 does not have):
fabricated `DEFAULT ''` on `events.start_at`/`end_at`/`timezone`, a missing
`guest_events_event_id_idx`, the stale single-column `guests_family_id_idx`
(prod has composite `guests_family_id_sort_idx` since migration 0004), and an
invented CHECK constraint on `rsvps.status` (no migration ever created one —
status validity is app-layer). Also deletes the fourth mirror: the mini-DDL in
`schema.test.ts` is gone; its constraint-behaviour tests now run on
`createDb()`'s primary mirror. Unblocks the Phase 0 `families` rebuild
(households ≠ claim codes) — see `cire/wiki/todo/platform.md`.
