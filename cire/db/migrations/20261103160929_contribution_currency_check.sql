-- A gift's currency is three characters long: `registry_contributions` gains
-- `registry_contributions_currency_ck` (`length(currency) = 3`) and
-- `registry_contributions_primary_currency_ck` (`primary_currency` NULL or
-- three characters long). Length only; the letters and their case are not
-- checked.
--
-- SQLite adds a CHECK only by rebuilding the table, so this copies and swaps
-- it, by hand: nothing references `registry_contributions` and no trigger or
-- view names it, so its DROP TABLE cascades nowhere. Every column is copied by
-- name, with the three foreign keys, the unique session id and the four indexes
-- under the names they already had. No PRAGMA foreign_keys line: SQLite ignores
-- one inside the transaction D1 runs a migration in, and nothing here needs it.
--
-- A plain INSERT, so a stored gift that breaks either check, or whose wedding,
-- household or fund is missing, fails the copy and stops the migration; it is
-- never skipped.
--
-- Written by hand (`db:generate --custom`), since `db:generate` refuses a
-- copy-and-swap; cire/db/src/schema.ts declares the same shape, and
-- cire/api/src/db/setup.ts mirrors it.
CREATE TABLE `__new_registry_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`item_id` text,
	`item_title` text,
	`family_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`primary_amount_minor` integer,
	`primary_currency` text,
	`fx_rate` text,
	`fx_rate_at` integer,
	`refunded_amount_minor` integer,
	`stripe_checkout_session_id` text,
	`stripe_payment_intent_id` text,
	`message` text,
	`display_name` text,
	`thanked_at` integer,
	`thanked_by` text,
	`note_hidden_at` integer,
	`note_hidden_by_osn_profile_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `registry_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `registry_contributions_currency_ck` CHECK (length(currency) = 3),
	CONSTRAINT `registry_contributions_primary_currency_ck` CHECK (primary_currency is null or length(primary_currency) = 3)
);
--> statement-breakpoint
INSERT INTO `__new_registry_contributions` (`id`, `wedding_id`, `item_id`, `item_title`, `family_id`, `status`, `amount_minor`, `currency`, `primary_amount_minor`, `primary_currency`, `fx_rate`, `fx_rate_at`, `refunded_amount_minor`, `stripe_checkout_session_id`, `stripe_payment_intent_id`, `message`, `display_name`, `thanked_at`, `thanked_by`, `note_hidden_at`, `note_hidden_by_osn_profile_id`, `created_at`, `updated_at`)
SELECT `id`, `wedding_id`, `item_id`, `item_title`, `family_id`, `status`, `amount_minor`, `currency`, `primary_amount_minor`, `primary_currency`, `fx_rate`, `fx_rate_at`, `refunded_amount_minor`, `stripe_checkout_session_id`, `stripe_payment_intent_id`, `message`, `display_name`, `thanked_at`, `thanked_by`, `note_hidden_at`, `note_hidden_by_osn_profile_id`, `created_at`, `updated_at`
FROM `registry_contributions`;--> statement-breakpoint
DROP TABLE `registry_contributions`;--> statement-breakpoint
ALTER TABLE `__new_registry_contributions` RENAME TO `registry_contributions`;--> statement-breakpoint
CREATE UNIQUE INDEX `registry_contributions_stripe_checkout_session_id_unique` ON `registry_contributions` (`stripe_checkout_session_id`);--> statement-breakpoint
CREATE INDEX `registry_contributions_wedding_created_idx` ON `registry_contributions` (`wedding_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `registry_contributions_item_idx` ON `registry_contributions` (`item_id`);--> statement-breakpoint
CREATE INDEX `registry_contributions_family_idx` ON `registry_contributions` (`family_id`);--> statement-breakpoint
CREATE INDEX `registry_contributions_payment_intent_idx` ON `registry_contributions` (`stripe_payment_intent_id`);
