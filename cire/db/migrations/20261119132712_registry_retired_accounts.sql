-- Accounts a wedding stopped naming by a retire.
--
-- An owner can retire the wedding's Stripe account: the holder hands money
-- gifts to another owner or disconnects, or another owner replaces it. A
-- retire calls Stripe for nothing, so the account stays connected to cire and
-- the refunds and disputes on gifts already paid into it keep arriving. One
-- row per retire records that cire still holds the account: its id, type and
-- connect time copied from the settings row, when and by whose standing it was
-- retired, and when cire let it go (`released_at`: a deauthorization, or a
-- hand-back of a Standard account). No profile id. It cascades with the
-- wedding.
--
-- The index on `stripe_account_id` serves the hand-back paths, the unmatched
-- refund log and the deauthorization's release, which each ask by account; the
-- one on `wedding_id` serves the purge's read of one wedding's rows and the
-- wedding delete's cascade. A new table starts empty, so nothing is back-filled.
--
-- The two CHECKs hold `reason` to its four values and the type to `express`,
-- `standard` or NULL. Nothing cascades from this table, so a fifth reason is a
-- hand-written rebuild.

CREATE TABLE `registry_retired_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`stripe_account_id` text NOT NULL,
	`stripe_account_type` text,
	`stripe_connected_at` integer,
	`retired_at` integer NOT NULL,
	`reason` text NOT NULL,
	`released_at` integer,
	`last_hand_back_at` integer,
	CONSTRAINT `fk_registry_retired_accounts_wedding_id_weddings_id_fk` FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON DELETE CASCADE,
	CONSTRAINT "registry_retired_accounts_reason_ck" CHECK(reason in ('handed_over','disconnected','replaced','holder_absent')),
	CONSTRAINT "registry_retired_accounts_type_ck" CHECK(stripe_account_type IS NULL OR stripe_account_type in ('express','standard'))
);
--> statement-breakpoint
CREATE INDEX `registry_retired_accounts_account_idx` ON `registry_retired_accounts` (`stripe_account_id`);--> statement-breakpoint
CREATE INDEX `registry_retired_accounts_wedding_idx` ON `registry_retired_accounts` (`wedding_id`);