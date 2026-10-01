-- Which organiser wrote an RSVP row last, and which organiser's attestation
-- its dietary consent record is. Both are opaque OSN profile ids with no
-- foreign key, like weddings.updated_by_osn_profile_id, and null on every row
-- the household wrote. Nullable, so no back-fill; ALTER TABLE ADD, never a
-- table rebuild.

ALTER TABLE `rsvps` ADD `recorded_by_osn_profile_id` text;--> statement-breakpoint
ALTER TABLE `rsvps` ADD `dietary_attested_by_osn_profile_id` text;