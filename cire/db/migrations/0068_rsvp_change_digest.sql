-- The RSVP change log and each organiser's read state.
--
-- `rsvp_changes` holds one row per guest-side RSVP change: ids, the kind and
-- the time, never a name or dietary data. `seq` is AUTOINCREMENT on purpose: it
-- is the cursor the portal feed and the daily digest keep, and a plain rowid is
-- reused once the newest rows are deleted, which would hide a new change behind
-- a cursor that already passed its number. `guest_id` and `event_id` carry no
-- foreign key; the household and wedding keys cascade, so the 1-year guest-data
-- sweep and a household delete take the rows. A daily cron deletes rows older
-- than 90 days.
--
-- `host_rsvp_notices` is one row per organiser per wedding: `seen_seq` for the
-- feed, `digest_seq` and `digest_enabled` for the email. No row reads as
-- "nothing seen, digest on".
--
-- drizzle-kit writes a boolean default as `DEFAULT true`; it is `DEFAULT 1` here
-- so the column reads back the same as the mirror in cire/api/src/db/setup.ts
-- (`ddl-lockstep.test.ts`).

CREATE TABLE `host_rsvp_notices` (
	`wedding_id` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`seen_seq` integer DEFAULT 0 NOT NULL,
	`digest_seq` integer DEFAULT 0 NOT NULL,
	`digest_enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`wedding_id`, `osn_profile_id`),
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rsvp_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wedding_id` text NOT NULL,
	`family_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`event_id` text,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rsvp_changes_wedding_idx` ON `rsvp_changes` (`wedding_id`);--> statement-breakpoint
CREATE INDEX `rsvp_changes_created_at_idx` ON `rsvp_changes` (`created_at`);--> statement-breakpoint
CREATE INDEX `rsvp_changes_family_idx` ON `rsvp_changes` (`family_id`);