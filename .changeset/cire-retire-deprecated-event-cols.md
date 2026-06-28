---
"@cire/api": patch
"@cire/db": patch
"@cire/web": patch
---

Retire the deprecated `events.date` and `events.location` columns.

They were kept "for backwards compatibility with migration 0001" but have been
fully superseded by the canonical timing (`start_at` / `end_at` / `timezone`) and
the canonical venue (`address`). This PR migrates every read + write off them and
then physically drops them via forward-only migration
`0025_drop_deprecated_event_cols.sql`:

- `/api/claim` + organiser `listEvents` responses (and the `EventSummary`
  schema/type) no longer emit `date` / `location`.
- The spreadsheet-import writer stopped setting them on event create/update.
- The retention sweep's "final event" selection now uses `MAX(end_at)` instead
  of `MAX(date)` (ISO strings are `YYYY-MM-DD`-prefixed, so the lexical
  comparison against the cutoff stays exact).
- The guest site renders the event day from `startAt` / `timezone`
  (`formatEventDay`) and the venue from `address` (`venueLine`); the organiser
  EventTable dropped its now-redundant Location row.
- LOCKSTEP DDL mirror in `cire/api/src/db/setup.ts` + the dev seed
  (`cire/db/seed/data/events.ts`, `generate.ts`, regenerated `dev-seed.sql`)
  were updated in lockstep.

Deploy note: the migration drops columns the old Worker code still expected, so
the drop is irreversible-forward — deploy the code, confirm healthy, and know
the dropped data cannot be recovered by rolling the code back.
