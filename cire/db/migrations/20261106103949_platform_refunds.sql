-- The record of an upgrade payment cire is giving back, outside the wedding's
-- cascade.
--
-- `platform_refunds` holds one row per purchase cire decided to refund: the
-- purchase id, the product, the PaymentIntent, what it took, why it could not
-- grant, the refund's status and Stripe id, and when the owners were emailed.
-- Like `platform_sales` it has no foreign key, no wedding id and no profile
-- id, so it outlives the purge; its Stripe ids make it pseudonymous, not
-- anonymous. The daily
-- reconciliation retries a refund from here, so the purge no longer waits on
-- one.
--
-- The CREATE statements are drizzle-kit's, as `db:generate` wrote them; they
-- match cire/db/src/schema.ts and cire/api/src/db/setup.ts
-- (`ddl-lockstep.test.ts`). The INSERT is written by hand: a purchase already
-- in a refund cire made gets its record, so the daily reconciliation,
-- `refund.failed` and the count of refunds waiting for a person still find it.
-- Its reason is `unrecorded`, since the row never stored one, and its owners
-- are not mailed. No deployed tier has sold an upgrade, so none is expected.
CREATE TABLE `platform_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL UNIQUE,
	`entitlement` text NOT NULL,
	`payment_intent_id` text,
	`amount_minor` integer,
	`currency` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`refund_id` text,
	`owners_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "platform_refunds_status_ck" CHECK(status in ('refunding','auto_refunded','refunded','refund_failed'))
);
--> statement-breakpoint
CREATE INDEX `platform_refunds_status_updated_idx` ON `platform_refunds` (`status`,`updated_at`);
--> statement-breakpoint
INSERT INTO `platform_refunds` (`id`, `purchase_id`, `entitlement`, `payment_intent_id`, `amount_minor`, `currency`, `reason`, `status`, `refund_id`, `owners_notified_at`, `created_at`, `updated_at`)
SELECT 'rfd_' || `id`, `id`, `entitlement`, `payment_intent_id`, `amount_minor`, `currency`, 'unrecorded', `status`, `refund_id`, NULL, `updated_at`, `updated_at`
FROM `wedding_upgrade_purchases`
WHERE `status` IN ('refunding', 'auto_refunded', 'refund_failed');
