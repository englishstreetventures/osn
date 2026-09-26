-- Plus-ones: a guest may bring one when an editor co-host allows it, and the
-- plus-one is an ordinary `guests` row that points at the guest who brought
-- them. See wiki/cire/cire-plus-ones.md.
--
--   plus_one_allowed      the permission, on the permitting guest's row.
--   plus_one_of_guest_id  set on a plus-one's row: the guest who brought them.
--                         Deleting that guest deletes the plus-one.
--
-- The unique index allows one plus-one per guest (SQLite admits any number of
-- NULLs under a unique index, so ordinary guests are unaffected). It is also
-- the probe the ON DELETE CASCADE runs on every guest delete.
--
-- Both columns are appended with ALTER TABLE ADD, never a table rebuild:
-- dropping `guests` under D1's always-on foreign keys would cascade into
-- `rsvps`, `guest_events` and `guest_account_links`.
--
-- Two hand edits to what drizzle-kit wrote, both so the migration matches the
-- mirror in cire/api/src/db/setup.ts and the Drizzle schema
-- (`ddl-lockstep.test.ts`):
--   - `DEFAULT 0`, not `DEFAULT false` (a boolean default reads back as text);
--   - `ON DELETE cascade` on the reference, which drizzle-kit leaves out of an
--     ADD COLUMN.
--
-- `rsvps.consent_source` gains the value `inviter_attested` in the same change.
-- The column is plain text with no CHECK constraint, so that needs no DDL.

ALTER TABLE `guests` ADD `plus_one_allowed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `guests` ADD `plus_one_of_guest_id` text REFERENCES guests(id) ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX `guests_plus_one_of_uniq` ON `guests` (`plus_one_of_guest_id`);
