-- Unlock codes: a code the platform owner mints to move a wedding to a paid
-- tier with no payment, and one row per wedding that redeemed one.
-- `unlock_codes` stores only each code's SHA-256 and sits outside the wedding
-- cascade, so `redeemed_count` keeps a use spent after the purge deletes the
-- wedding that spent it. See wiki/cire/cire-entitlements.md.
CREATE TABLE `unlock_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`tier` text NOT NULL,
	`max_redemptions` integer NOT NULL,
	`redeemed_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "unlock_codes_tier_ck" CHECK(tier in ('gold','crimson')),
	CONSTRAINT "unlock_codes_uses_ck" CHECK(max_redemptions >= 1 and redeemed_count >= 0 and redeemed_count <= max_redemptions)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unlock_codes_code_hash_unique` ON `unlock_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `unlock_code_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`code_id` text NOT NULL,
	`wedding_id` text NOT NULL,
	`redeemed_by_osn_profile_id` text,
	`redeemed_at` integer NOT NULL,
	FOREIGN KEY (`code_id`) REFERENCES `unlock_codes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unlock_code_redemptions_code_wedding_uniq` ON `unlock_code_redemptions` (`code_id`,`wedding_id`);--> statement-breakpoint
CREATE INDEX `unlock_code_redemptions_wedding_idx` ON `unlock_code_redemptions` (`wedding_id`);
