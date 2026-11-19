-- A gift keeps the account it was paid into.
--
-- `registry_contributions` gains `stripe_account_id` and `stripe_account_type`:
-- the connected account a gift's Checkout session was created on, and that
-- account's type as the wedding's settings row stored it (NULL reads as
-- `express`). Gift events match a gift by this account, so a refund, dispute or
-- late settle on an account the wedding no longer names still reaches it. The
-- index on (`stripe_account_id`, `status`) is for the question "is any gift on
-- this account still pending?".
--
-- The back-fill gives a gift its wedding's current account only where that is
-- certainly the account the gift was made on. Every clear of an account goes
-- through the deauthorization, which stamps `stripe_deauthorized_at` with
-- Stripe's event time, and neither the attach nor the reuse moves it, so a
-- gift with a Checkout session, created after that time and not before the
-- current account was connected (`stripe_connected_at`, cire's clock on an
-- attach, the source's on a reuse), was made on the current account. The
-- session matters because the clear can land days after Stripe's event while
-- Stripe retries: an attempt in between was made against the old account, and
-- Stripe, which refuses any session on a deauthorized account, gave it none.
-- Every other gift stays NULL, and the webhook matches it through the
-- wedding's current account, as before this column.
--
-- `registry_settings` gains `stripe_account_generation`, NOT NULL DEFAULT 0. The
-- trigger `registry_settings_stripe_account_generation` adds one whenever
-- `stripe_account_id` goes from a value to NULL, by any statement and any
-- Worker. Its WHEN reads the id alone: a deauthorization NULLs the type and
-- connect time in the same UPDATE, so the condition of
-- `registry_settings_stripe_account_cleared` would miss it.
--
-- The trigger `registry_contributions_stripe_account_filled` copies the
-- wedding's account and type onto a gift inserted without an account, which
-- only a Worker from before this migration writes (the deploy window, or a
-- rollback). It reads the account at the insert, not at that Worker's gate
-- read; if the account changed in between, an event on the earlier account is
-- refused, as it was before this migration. A rebuild of either table must
-- create this trigger again; `ddl-lockstep.test.ts` fails without it.
--
-- Additive: three ALTER TABLE ADD and a CREATE INDEX (drizzle-kit's, as
-- `db:generate` wrote them), with the back-fill, by hand, before the index so
-- the rows it fills write no index entry, then the two triggers by hand. All
-- of it matches cire/db/src/schema.ts and cire/api/src/db/setup.ts
-- (`ddl-lockstep.test.ts`).
ALTER TABLE `registry_contributions` ADD `stripe_account_id` text;--> statement-breakpoint
ALTER TABLE `registry_contributions` ADD `stripe_account_type` text;--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `stripe_account_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `registry_contributions`
SET `stripe_account_id` = (SELECT s.`stripe_account_id` FROM `registry_settings` s WHERE s.`wedding_id` = `registry_contributions`.`wedding_id`),
	`stripe_account_type` = (SELECT s.`stripe_account_type` FROM `registry_settings` s WHERE s.`wedding_id` = `registry_contributions`.`wedding_id`)
WHERE `stripe_account_id` IS NULL
	AND `stripe_checkout_session_id` IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM `registry_settings` s
		WHERE s.`wedding_id` = `registry_contributions`.`wedding_id`
			AND s.`stripe_account_id` IS NOT NULL
			AND (s.`stripe_deauthorized_at` IS NULL OR `registry_contributions`.`created_at` > s.`stripe_deauthorized_at`)
			AND (s.`stripe_connected_at` IS NULL OR `registry_contributions`.`created_at` >= s.`stripe_connected_at`)
	);--> statement-breakpoint
CREATE INDEX `registry_contributions_account_status_idx` ON `registry_contributions` (`stripe_account_id`,`status`);--> statement-breakpoint
CREATE TRIGGER `registry_settings_stripe_account_generation` AFTER UPDATE OF `stripe_account_id` ON `registry_settings`
WHEN OLD.`stripe_account_id` IS NOT NULL AND NEW.`stripe_account_id` IS NULL
BEGIN
	UPDATE `registry_settings` SET `stripe_account_generation` = `stripe_account_generation` + 1 WHERE `wedding_id` = NEW.`wedding_id`;
END;--> statement-breakpoint
CREATE TRIGGER `registry_contributions_stripe_account_filled` AFTER INSERT ON `registry_contributions`
WHEN NEW.`stripe_account_id` IS NULL
BEGIN
	UPDATE `registry_contributions`
	SET `stripe_account_id` = (SELECT s.`stripe_account_id` FROM `registry_settings` s WHERE s.`wedding_id` = NEW.`wedding_id`),
		`stripe_account_type` = (SELECT s.`stripe_account_type` FROM `registry_settings` s WHERE s.`wedding_id` = NEW.`wedding_id`)
	WHERE `id` = NEW.`id`
		AND EXISTS (SELECT 1 FROM `registry_settings` s WHERE s.`wedding_id` = NEW.`wedding_id` AND s.`stripe_account_id` IS NOT NULL);
END;
