-- Everything the gift stack adds on top of the squashed baseline, in one
-- migration because the squash reset the chain to `0001_initial`.
--
--  * `stripe_checkout_session_id` becomes NULLABLE. The contribution row is
--    written BEFORE Stripe is told anything, so the orphan falls on our side
--    where it can be seen and closed; a NOT NULL column made that impossible.
--    SQLite cannot relax a constraint in place, hence the table rebuild.
--  * an index on `stripe_payment_intent_id` — a refund or dispute event carries
--    a charge, never a session, so the intent is the only link back to the row.
--  * `gift_summary_json` + `gift_summary_at` — what survives the 1-year sweep.
--  * `stripe_deauthorized_at` + `stripe_deauthorized_account_id` — what a
--    couple revoking cire's access leaves behind once the account id is cleared.
--  * `refunded_amount_minor` on the rebuilt table — what went back. A partial
--    refund leaves the status at `succeeded` and records the amount here, so the
--    row stops claiming the couple kept the whole gift.
--  * `stripe_default_currency` — the connected account's own settlement currency.
--    Under direct charges the couple is the merchant of record, so that is the
--    currency a Checkout Session has to be priced in.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_registry_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`item_id` text,
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `registry_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_registry_contributions`("id", "wedding_id", "item_id", "family_id", "status", "amount_minor", "currency", "primary_amount_minor", "primary_currency", "fx_rate", "fx_rate_at", "stripe_checkout_session_id", "stripe_payment_intent_id", "message", "display_name", "thanked_at", "thanked_by", "created_at", "updated_at") SELECT "id", "wedding_id", "item_id", "family_id", "status", "amount_minor", "currency", "primary_amount_minor", "primary_currency", "fx_rate", "fx_rate_at", "stripe_checkout_session_id", "stripe_payment_intent_id", "message", "display_name", "thanked_at", "thanked_by", "created_at", "updated_at" FROM `registry_contributions`;--> statement-breakpoint
DROP TABLE `registry_contributions`;--> statement-breakpoint
ALTER TABLE `__new_registry_contributions` RENAME TO `registry_contributions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `registry_contributions_stripe_checkout_session_id_unique` ON `registry_contributions` (`stripe_checkout_session_id`);--> statement-breakpoint
CREATE INDEX `registry_contributions_wedding_created_idx` ON `registry_contributions` (`wedding_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `registry_contributions_item_idx` ON `registry_contributions` (`item_id`);--> statement-breakpoint
CREATE INDEX `registry_contributions_payment_intent_idx` ON `registry_contributions` (`stripe_payment_intent_id`);--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `stripe_deauthorized_at` integer;--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `stripe_deauthorized_account_id` text;--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `gift_summary_json` text;--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `gift_summary_at` integer;--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `stripe_default_currency` text;