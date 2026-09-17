CREATE TABLE `platform_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`entitlement` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`settled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_sales_purchase_id_unique` ON `platform_sales` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `wedding_upgrade_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`entitlement` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`checkout_session_id` text,
	`payment_intent_id` text,
	`amount_minor` integer,
	`currency` text,
	`created_by_osn_profile_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_upgrade_purchases_checkout_session_id_unique` ON `wedding_upgrade_purchases` (`checkout_session_id`);--> statement-breakpoint
CREATE INDEX `wedding_upgrade_purchases_wedding_entitlement_idx` ON `wedding_upgrade_purchases` (`wedding_id`,`entitlement`);--> statement-breakpoint
CREATE INDEX `wedding_upgrade_purchases_payment_intent_idx` ON `wedding_upgrade_purchases` (`payment_intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_upgrade_purchases_one_pending_uniq` ON `wedding_upgrade_purchases` (`wedding_id`,`entitlement`) WHERE status = 'pending';