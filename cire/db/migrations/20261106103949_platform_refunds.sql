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
-- one. New and empty: nothing to back-fill, since no deployed tier has sold an
-- upgrade.
--
-- The statements are drizzle-kit's, as `db:generate` wrote them; they match
-- cire/db/src/schema.ts and cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`).
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
