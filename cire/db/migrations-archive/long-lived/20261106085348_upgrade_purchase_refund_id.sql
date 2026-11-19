-- The Stripe refund cire made for an upgrade payment it could not grant, the
-- index the daily reconciliation reads by, and the triggers that hold an
-- upgrade purchase's `status` to the values cire writes.
--
-- `wedding_upgrade_purchases` gains `refund_id`, the `re_…` id Stripe returned
-- when it accepted cire's refund. Nullable with no default and no back-fill:
-- every existing row holds NULL, which is what a purchase nobody refunded, or
-- one a person refunded by hand, reads as. The new statuses that go with it
-- (`refunding`, `auto_refunded`, `refund_failed`) need no DDL: `status` has no
-- CHECK constraint.
--
-- `wedding_upgrade_purchases_status_updated_idx` serves the daily read of
-- `refunding` and stale `pending` rows, least recently moved first.
--
-- Two triggers refuse a `status` outside the set settle, the purge and the
-- reconciliation know: a CHECK cannot be added without a copy-and-swap, and
-- operators write this column by hand (`grant-tier.ts --lower`, the refund
-- runbook). Every value any release has written is in the set.
--
-- Additive: ALTER TABLE ADD, CREATE INDEX and CREATE TRIGGER, never a
-- rebuild. The first two are drizzle-kit's, as `db:generate` wrote them, and
-- the triggers are written by hand; all match
-- cire/db/src/schema.ts and cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`).
ALTER TABLE `wedding_upgrade_purchases` ADD `refund_id` text;--> statement-breakpoint
CREATE INDEX `wedding_upgrade_purchases_status_updated_idx` ON `wedding_upgrade_purchases` (`status`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `wedding_upgrade_purchases_status_known` BEFORE INSERT ON `wedding_upgrade_purchases`
WHEN NEW.`status` NOT IN ('pending', 'succeeded', 'failed', 'expired', 'refunded', 'mismatch', 'refunding', 'auto_refunded', 'refund_failed')
BEGIN
	SELECT RAISE(ABORT, 'upgrade purchase status is not one cire writes');
END;--> statement-breakpoint
CREATE TRIGGER `wedding_upgrade_purchases_status_known_update` BEFORE UPDATE OF `status` ON `wedding_upgrade_purchases`
WHEN NEW.`status` NOT IN ('pending', 'succeeded', 'failed', 'expired', 'refunded', 'mismatch', 'refunding', 'auto_refunded', 'refund_failed')
BEGIN
	SELECT RAISE(ABORT, 'upgrade purchase status is not one cire writes');
END;
