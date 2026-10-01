-- Household member identity: which member of a household a browser's session
-- says it is, and which member sent each reply. See
-- docs/superpowers/specs/2026-10-01-cire-household-member-identity-design.md.
--
--   sessions.member_guest_id       the member this session chose; null until
--                                  chosen and after "Not you?".
--   rsvps.submitted_by_guest_id    the member whose session wrote the row last;
--                                  null for organiser-recorded rows.
--   rsvps.submitted_via_link       that write carried a musubi sign-in matching
--                                  the member's account link.
--   rsvp_changes.actor_guest_id    the member who made the change. No foreign
--                                  key, like the table's `guest_id`.
--
-- Every column is nullable or defaulted, so no row needs a back-fill. All are
-- appended with ALTER TABLE ADD, never a table rebuild: dropping `rsvps` or
-- `sessions` under D1's always-on foreign keys is not safe.
--
-- The two references are SET NULL, not cascade: deleting one member must not
-- delete replies they sent for others. Each has a PARTIAL index, the probe the
-- SET NULL runs on every guest delete (almost every row is NULL there, the
-- reason `guests_plus_one_of_uniq` is partial).
--
-- Two hand edits to what drizzle-kit wrote, so the migration matches the
-- Drizzle schema and cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`):
--   - `ON DELETE set null` on both references, which drizzle-kit leaves out
--     of an ADD COLUMN;
--   - `DEFAULT 0`, not `DEFAULT false` (a boolean default reads back as text).

ALTER TABLE `rsvp_changes` ADD `actor_guest_id` text;--> statement-breakpoint
ALTER TABLE `rsvps` ADD `submitted_by_guest_id` text REFERENCES guests(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `rsvps` ADD `submitted_via_link` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `rsvps_submitted_by_idx` ON `rsvps` (`submitted_by_guest_id`) WHERE submitted_by_guest_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `member_guest_id` text REFERENCES guests(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `sessions_member_idx` ON `sessions` (`member_guest_id`) WHERE member_guest_id IS NOT NULL;
