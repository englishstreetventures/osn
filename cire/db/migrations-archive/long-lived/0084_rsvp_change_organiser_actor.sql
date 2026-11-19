-- The change log also records each organiser status-only save, naming the
-- organiser: an opaque OSN profile id with no foreign key, like
-- rsvps.recorded_by_osn_profile_id, and null on every row a household wrote.
-- Nullable, so no back-fill; ALTER TABLE ADD, never a table rebuild.
-- The feed and the digest read only the household's rows, so both indexes
-- they range over hold those rows apart: the wedding index gains the actor
-- column (replacing the single-column one, which goes last so the wedding
-- cascade always has an index), and the digest's look-back gets a partial
-- index of its own. Neither read steps over an organiser's rows.
ALTER TABLE `rsvp_changes` ADD `actor_osn_profile_id` text;--> statement-breakpoint
CREATE INDEX `rsvp_changes_wedding_actor_idx` ON `rsvp_changes` (`wedding_id`,`actor_osn_profile_id`);--> statement-breakpoint
CREATE INDEX `rsvp_changes_household_created_at_idx` ON `rsvp_changes` (`created_at`) WHERE actor_osn_profile_id IS NULL;--> statement-breakpoint
DROP INDEX `rsvp_changes_wedding_idx`;
