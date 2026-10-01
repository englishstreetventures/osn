-- Plan tiers: Ivory (free), Gold and Crimson, one per wedding.
--
-- `weddings.tier` replaces the per-module entitlement packs as what a wedding
-- has paid for. Every wedding starts at `ivory`; the backfill at the end lifts
-- the ones whose legacy `wedding_entitlements` rows already paid for more:
-- `vendors` or `capacity_1000` to Crimson, then `registry` or `capacity_500` to
-- Gold for any still on Ivory. Each lifted row records `tier_source =
-- 'migration'`. No entitlement row is deleted here, because the Worker that
-- reads them is still serving between this migration and its own deploy.
--
-- The one-pending purchase index narrows from (wedding_id, entitlement) to
-- (wedding_id): a wedding moves to one tier at a time. Any purchase still
-- pending is a legacy per-module attempt that no tier checkout will resume,
-- and two of them on one wedding would fail the new index, so they are expired
-- between dropping the old index and creating the new one. Its webhook still
-- settles, because settle accepts an expired row.
--
-- `wedding_upgrade_purchases.from_tier` records the tier a purchase started
-- from, and `price_id`, `price_amount_minor` and `price_currency` the Stripe
-- Price it opened at and what that Price charges; settle grants only for a
-- payment of that amount. All four are NULL on every row before this
-- migration.

DROP INDEX `wedding_upgrade_purchases_one_pending_uniq`;--> statement-breakpoint
ALTER TABLE `wedding_upgrade_purchases` ADD `from_tier` text;--> statement-breakpoint
ALTER TABLE `wedding_upgrade_purchases` ADD `price_id` text;--> statement-breakpoint
ALTER TABLE `wedding_upgrade_purchases` ADD `price_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `wedding_upgrade_purchases` ADD `price_currency` text;--> statement-breakpoint
UPDATE `wedding_upgrade_purchases` SET `status` = 'expired', `updated_at` = unixepoch() WHERE `status` = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_upgrade_purchases_one_pending_uniq` ON `wedding_upgrade_purchases` (`wedding_id`) WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE `weddings` ADD `tier` text DEFAULT 'ivory' NOT NULL;--> statement-breakpoint
ALTER TABLE `weddings` ADD `tier_source` text;--> statement-breakpoint
ALTER TABLE `weddings` ADD `tier_granted_by` text;--> statement-breakpoint
UPDATE `weddings` SET `tier` = 'crimson', `tier_source` = 'migration' WHERE `tier` = 'ivory' AND `id` IN (SELECT `wedding_id` FROM `wedding_entitlements` WHERE `entitlement` IN ('vendors', 'capacity_1000'));--> statement-breakpoint
UPDATE `weddings` SET `tier` = 'gold', `tier_source` = 'migration' WHERE `tier` = 'ivory' AND `id` IN (SELECT `wedding_id` FROM `wedding_entitlements` WHERE `entitlement` IN ('registry', 'capacity_500'));
