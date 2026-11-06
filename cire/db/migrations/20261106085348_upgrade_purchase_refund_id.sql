-- The Stripe refund cire made for an upgrade payment it could not grant, and
-- the index the daily reconciliation reads by.
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
-- Additive: ALTER TABLE ADD and CREATE INDEX, never a rebuild. The statements
-- are drizzle-kit's, as `db:generate` wrote them; they match
-- cire/db/src/schema.ts and cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`).
ALTER TABLE `wedding_upgrade_purchases` ADD `refund_id` text;--> statement-breakpoint
CREATE INDEX `wedding_upgrade_purchases_status_updated_idx` ON `wedding_upgrade_purchases` (`status`,`updated_at`);
