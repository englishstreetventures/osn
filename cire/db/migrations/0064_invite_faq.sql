-- The invite's FAQ section: the `wedding_faqs` table and the section's
-- visibility switch, `faq_visible`, in one change.
--
-- Entries are ordered by `sort_order` (ties broken by `id`), and the composite
-- index serves the `WHERE wedding_id = ? ORDER BY sort_order, id` read without
-- a sort, as `registry_items_wedding_sort_idx` does.
--
-- The switch defaults to on and there is no backfill: no wedding has entries
-- yet, so every existing invite reads "switched on, empty" and renders exactly
-- as before.
--
-- drizzle-kit writes a boolean default as `DEFAULT true`; it is `DEFAULT 1` here
-- so the column reads back the same as the mirror in cire/api/src/db/setup.ts
-- and the Drizzle schema (`ddl-lockstep.test.ts`).

CREATE TABLE `wedding_faqs` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wedding_faqs_wedding_sort_idx` ON `wedding_faqs` (`wedding_id`,`sort_order`,`id`);--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `faq_visible` integer DEFAULT 1 NOT NULL;