-- The change log also records each organiser status-only save, naming the
-- organiser: an opaque OSN profile id with no foreign key, like
-- rsvps.recorded_by_osn_profile_id, and null on every row a household wrote.
-- Nullable, so no back-fill; ALTER TABLE ADD, never a table rebuild.
-- The feed reads only the household's rows, so they get an index of their own:
-- a feed read of up to 5,001 household changes never steps over an
-- organiser's rows.
ALTER TABLE `rsvp_changes` ADD `actor_osn_profile_id` text;--> statement-breakpoint
CREATE INDEX `rsvp_changes_household_idx` ON `rsvp_changes` (`wedding_id`) WHERE actor_osn_profile_id IS NULL;