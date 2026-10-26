-- Guest email addresses.
--
-- `guests` gains the address and its consent record: who supplied it
-- (`email_source`, 'guest' | 'organiser_attested'), when, under which wording
-- (`email_consent_version`), and the organiser who attested, if one did, plus
-- the address's suppression hash (`email_hash`). All nullable: NULL is a guest
-- with no address.
--
-- `email_suppressions` is the list guest comms must not email: per wedding,
-- holding a SHA-256 of the wedding id and the address, never the address, and
-- the seat that withdrew it. Cascades with the wedding; a removed guest's
-- opt-out stays, with `guest_id` SET NULL.
--
-- Additive: ALTER TABLE ADD and a new table, never a rebuild. The statements
-- are drizzle-kit's, as `db:generate` wrote them; they match
-- cire/db/src/schema.ts and cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`).
CREATE TABLE `email_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`email_hash` text NOT NULL,
	`guest_id` text,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_email_suppressions_wedding_id_weddings_id_fk` FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_email_suppressions_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `guests` ADD `email` text;--> statement-breakpoint
ALTER TABLE `guests` ADD `email_source` text;--> statement-breakpoint
ALTER TABLE `guests` ADD `email_consent_at` integer;--> statement-breakpoint
ALTER TABLE `guests` ADD `email_consent_version` text;--> statement-breakpoint
ALTER TABLE `guests` ADD `email_attested_by_osn_profile_id` text;--> statement-breakpoint
ALTER TABLE `guests` ADD `email_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `email_suppressions_seat_uniq` ON `email_suppressions` (`wedding_id`,`email_hash`,`guest_id`);--> statement-breakpoint
CREATE INDEX `email_suppressions_guest_idx` ON `email_suppressions` (`guest_id`) WHERE guest_id IS NOT NULL;