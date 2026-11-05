-- Stripe Connect OAuth: a couple can connect a Stripe account made outside cire.
--
-- `registry_settings` gains `stripe_account_type`: `express` for an account
-- cire created, `standard` for the couple's own account connected through
-- OAuth. Nullable, no back-fill: NULL beside an account reads as `express`,
-- which every account attached before this column is. Two triggers refuse any
-- other value, as the vendors stage triggers do, since a CHECK added to an
-- existing table is a copy-and-swap.
--
-- `registry_stripe_oauth_states` holds one pending OAuth sign-in per owner per
-- wedding: the SHA-256 of the `state` sent to Stripe, and when it lapses. The
-- callback deletes the row it matches; the wedding's purge cascades it.
--
-- Additive: CREATE TABLE, ALTER TABLE ADD, CREATE INDEX, CREATE TRIGGER. The
-- first three are drizzle-kit's, as `db:generate` wrote them; the triggers are
-- by hand. All of it matches cire/db/src/schema.ts and cire/api/src/db/setup.ts
-- (`ddl-lockstep.test.ts`).
CREATE TABLE `registry_stripe_oauth_states` (
	`wedding_id` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `registry_stripe_oauth_states_pk` PRIMARY KEY(`wedding_id`, `osn_profile_id`),
	CONSTRAINT `fk_registry_stripe_oauth_states_wedding_id_weddings_id_fk` FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `registry_settings` ADD `stripe_account_type` text;--> statement-breakpoint
CREATE INDEX `registry_stripe_oauth_states_expires_idx` ON `registry_stripe_oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TRIGGER `registry_settings_stripe_account_type` BEFORE INSERT ON `registry_settings`
WHEN NEW.`stripe_account_type` IS NOT NULL AND NEW.`stripe_account_type` NOT IN ('express', 'standard')
BEGIN
	SELECT RAISE(ABORT, 'stripe account type is not express or standard');
END;--> statement-breakpoint
CREATE TRIGGER `registry_settings_stripe_account_type_update` BEFORE UPDATE OF `stripe_account_type` ON `registry_settings`
WHEN NEW.`stripe_account_type` IS NOT NULL AND NEW.`stripe_account_type` NOT IN ('express', 'standard')
BEGIN
	SELECT RAISE(ABORT, 'stripe account type is not express or standard');
END;
