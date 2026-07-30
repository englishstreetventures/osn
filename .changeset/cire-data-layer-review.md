---
"@cire/api": patch
"@cire/db": patch
---

Data-layer review fixes for the cire stack (schema, migrations 0051–0054, and
the query layer).

**Correctness**

- The three reorder endpoints (`tasks`, `budget`, `vendors`) no longer use
  `db.transaction()` — Drizzle's D1 driver implements it as literal
  `BEGIN`/`COMMIT` (rejected by D1) and the synchronous callback never awaited
  its writes. They now commit one atomic `commitBatch`, with first-ever D1
  integration coverage of a reorder.
- `events.slug` uniqueness descoped from GLOBAL to `(wedding_id, slug)`
  (migration 0051): two weddings importing a same-named event used to collide
  and fail the second apply. Slug minting now de-dupes within a wedding
  (`-2`, `-3`, …) and never mints an empty slug.
- The bulk code remint no longer exceeds D1's 50-statement batch cap past ~24
  families: new `commitGroupedBatches` chunks the write set without ever
  splitting a family's [code rotate, session revoke] pair. The four
  byte-identical private `commitBatch` copies now import the shared helper.
- Import apply/revert status flips ride in the write set's FINAL batch
  (`applyImport` `finalize`), closing the crash window that could leave data
  mutated with the change row still `preview` — which allowed a second apply to
  overwrite the before-image and destroy revertability.
- `guest_events.event_id` + `rsvps.event_id` FKs upgraded NO ACTION → CASCADE
  (migration 0052, leaf-table rebuild) so the future wedding-delete flow can't
  trip them; the retention sweep now deletes `guest_events` explicitly per its
  own no-cascade contract.
- `replaceCategories` (delete-then-insert) and `enquiries.quote`'s two
  quoted-minor mirror updates are each one atomic batch.

**Housekeeping + efficiency**

- Migration 0053: `sessions(family_id)` + `sessions(expires_at)` indexes
  (matching `organiser_sessions`; revoke sites + nightly sweep were full
  scans), `weddings(created_at)` (public primary-wedding lookup),
  `rsvps(event_id)` (in 0052); dropped the dead `families_family_name_idx` and
  the PK-redundant `directory_vendor_categories_category_idx`; directory browse
  now has a `(listed, name, id)` composite serving filter + ORDER BY.
- New daily cron sweeps: expired `vendor_claims` tokens and abandoned
  `preview` change rows (incl. their uploaded-sheet CSVs in R2) — both
  previously accumulated indefinitely.
- `vendors`/`budget`/`tasks` single-row writes collapsed to
  `UPDATE/DELETE … RETURNING` (1 round trip instead of 3–4); revert's legacy
  prior-import scan narrowed to a `LIMIT 1`; both enquiry inboxes sort in SQL;
  directory OFFSET clamp tightened 1e6 → 10k.
- `events` gains nullable `created_at`/`updated_at` (migration 0054), stamped
  by the importer and event-image writes.
- `db:generate` repaired: drizzle journal backfilled 0009–0054 with a
  regenerated snapshot, so `drizzle-kit generate` diffs cleanly again and
  numbers the next migration correctly; `cire/db/README.md` rewritten to match
  reality.
