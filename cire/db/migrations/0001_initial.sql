-- 0001_initial.sql — the cire D1 BASELINE.
--
-- This one file creates the whole schema. It replaces migrations 0001–0057,
-- which were squashed on 2026-09-10 (xchromo/osn#981). Their text is in git
-- history; nothing else needs it.
--
-- WHY: building a database from the 57-file chain cost 8,007 D1 rows written
-- and about 22,630 read, almost all of it schema churn — SQLite rebuilds the
-- whole table for every `ALTER TABLE ... DROP COLUMN`, and D1 bills that even
-- against empty tables. The free tier allows 100,000 rows written a day across
-- every database on the account. See xchromo/osn#979.
--
-- WHY IT IS SAFE FOR PRODUCTION: `wrangler d1 migrations apply` skips any file
-- already named in the database's `d1_migrations` ledger. Production's ledger
-- holds `0001_initial.sql` — this filename — so wrangler skips it and runs
-- nothing. The other 56 ledger rows name files that no longer exist, which
-- wrangler does not mind. `d1 migrations list --env production` must keep
-- saying "No migrations to apply!"; that is the check, and it is in the PR.
--
-- KEEP THE FILENAME. Renaming it to anything not in the production ledger
-- makes wrangler run this file against the live wedding database, where every
-- CREATE TABLE fails because the tables are already there.
--
-- GENERATED from the 57-migration chain, so the column ORDER here is the order
-- production actually has (D1's ALTER TABLE ADD COLUMN can only append, so it
-- diverges from schema.ts) and index names are the real ones. Verified by
-- cire/api/tests/db/ddl-lockstep.test.ts (T-S1), which diffs this against the
-- DDL mirror in cire/api/src/db/setup.ts and the Drizzle schema.
--
-- New migrations start at 0058 and are applied incrementally, as before.

-- ── Tables ─────────────────────────────────────────────────────────────────
CREATE TABLE `guests` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `first_name` text NOT NULL,
  `last_name` text DEFAULT '' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL, `external_id` text, `nickname` text, `source` text DEFAULT 'import' NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `token` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `weddings` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `display_name` text NOT NULL,
  `owner_osn_profile_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
, `code_style` text DEFAULT 'secure' NOT NULL, `wedding_date` text, `guest_count_estimate` integer, `currency` text NOT NULL DEFAULT 'AUD', `budget_total_minor` integer, `rsvp_deadline` text, `rsvp_deadline_timezone` text, `updated_by_osn_profile_id` text);
--> statement-breakpoint
CREATE TABLE "events" (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `start_at` text NOT NULL,
  `end_at` text NOT NULL,
  `timezone` text NOT NULL,
  `address` text,
  `dress_code_description` text,
  `dress_code_palette` text,
  `pinterest_url` text,
  `maps_url` text,
  `sort_order` integer DEFAULT 0 NOT NULL, `event_image_key` text, `event_image_crop` text, `created_at` integer, `updated_at` integer,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "imports" (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `uploaded_at` integer NOT NULL,
  `format` text NOT NULL,
  `events_r2_key` text NOT NULL,
  `guests_r2_key` text NOT NULL,
  `summary` text NOT NULL,
  `status` text NOT NULL,
  `applied_at` integer,
  `reverted_at` integer, `kind` text DEFAULT 'import' NOT NULL, `before_events_r2_key` text, `before_guests_r2_key` text,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `guest_account_links` (
	`id` text PRIMARY KEY NOT NULL,
	`guest_id` text NOT NULL,
	`family_id` text NOT NULL,
	`wedding_id` text NOT NULL,
	`osn_account_id` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wedding_invite_customisations` (
	`wedding_id` text PRIMARY KEY NOT NULL,
	`hero_title` text,
	`hero_subtitle` text,
	`story_eyebrow` text,
	`story_heading` text,
	`story_body` text,
	`hero_image_key` text,
	`story_image_key` text,
	`updated_at` integer NOT NULL, `theme_heading_font` text, `theme_body_font` text, `hero_blur` integer DEFAULT 28 NOT NULL, `hero_title_backdrop_opacity` integer DEFAULT 0 NOT NULL, `hero_title_backdrop_blur` integer DEFAULT 0 NOT NULL, `hero_image_crop` text, `story_image_crop` text, invite_message text, `details_eyebrow` text, `details_heading` text, `welcome_message` text, `images_updated_at` INTEGER, `palette_preset` text, `palette_ground` text, `palette_card` text, `palette_ink` text, `palette_gilt` text, `palette_bloom` text, `hero_tone` text, `story_tone` text, `details_tone` text, `welcome_tone` text, design_id TEXT NOT NULL DEFAULT 'classic', `hero_image_crop_mobile` text, theme_heading_size TEXT, theme_heading_weight TEXT, theme_heading_style TEXT, theme_body_weight TEXT, theme_body_style TEXT, `footer_message` text, `footer_image_key` text, `footer_image_crop` text, `registry_eyebrow` text, `registry_heading` text, `registry_body` text, `registry_tone` text,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wedding_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`added_by_osn_profile_id` text NOT NULL,
	`role` text DEFAULT 'host' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "families" (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `public_id` text NOT NULL UNIQUE,
  `family_name` text NOT NULL,
  `kind` text DEFAULT 'guest' NOT NULL,
  `code_shared_at` integer,
  `first_opened_at` integer,
  `deactivated_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL, `source` text DEFAULT 'import' NOT NULL,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `notes` text,
  `timeframe_bucket` text NOT NULL,
  `due_at` text,
  `status` text DEFAULT 'open' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `budget_items` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  `name` text NOT NULL,
  `estimate_minor` integer,
  `quoted_minor` integer,
  `actual_minor` integer,
  `notes` text,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
  `id` text PRIMARY KEY NOT NULL,
  `budget_item_id` text NOT NULL REFERENCES `budget_items`(`id`) ON DELETE CASCADE,
  `label` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `due_at` text,
  `paid_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `directory_vendors` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_org_id` text,
  `name` text NOT NULL,
  `description` text,
  `email` text,
  `phone` text,
  `website` text,
  `instagram` text,
  `location_text` text,
  `price_band` text,
  `price_min_minor` integer,
  `price_max_minor` integer,
  `listed` text NOT NULL DEFAULT 'draft',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
, `lead_forward_email` text, `claimed_by_profile_id` text);
--> statement-breakpoint
CREATE TABLE `directory_vendor_categories` (
  `directory_vendor_id` text NOT NULL REFERENCES `directory_vendors`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  PRIMARY KEY (`directory_vendor_id`, `category`)
);
--> statement-breakpoint
CREATE TABLE `vendors` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `directory_vendor_id` text,
  `name` text NOT NULL,
  `category` text NOT NULL,
  `status` text NOT NULL DEFAULT 'researching',
  `contact_name` text,
  `email` text,
  `phone` text,
  `notes` text,
  `quoted_minor` integer,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vendor_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `directory_vendor_id` text NOT NULL REFERENCES `directory_vendors`(`id`) ON DELETE CASCADE,
  `token_hash` text NOT NULL UNIQUE,
  `email` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer
);
--> statement-breakpoint
CREATE TABLE `wedding_entitlements` (
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `entitlement` text NOT NULL,
  `source` text NOT NULL,
  `granted_at` integer NOT NULL,
  `granted_by` text NOT NULL,
  `provider_ref` text,
  PRIMARY KEY (`wedding_id`, `entitlement`)
);
--> statement-breakpoint
CREATE TABLE `vendor_enquiries` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `directory_vendor_id` text NOT NULL,
  `vendor_id` text NOT NULL REFERENCES `vendors`(`id`) ON DELETE CASCADE,
  `zap_chat_id` text,
  `pending_body` text,
  `status` text NOT NULL DEFAULT 'open',
  `created_by` text NOT NULL,
  `quoted_minor` integer,
  `last_message_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organiser_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`osn_sub` text NOT NULL,
	`email` text,
	`handle` text,
	`display_name` text,
	`avatar_url` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_events" (
	`guest_id` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`guest_id`, `event_id`),
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "rsvps" (
	`id` text PRIMARY KEY NOT NULL,
	`guest_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`dietary` text DEFAULT '' NOT NULL,
	`dietary_consent_at` integer,
	`dietary_consent_version` text,
	`consent_source` text DEFAULT 'guest' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `registry_settings` (
  `wedding_id` text PRIMARY KEY NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `published` integer DEFAULT 0 NOT NULL,
  `headline` text,
  `message` text,
  `cash_gifts_enabled` integer DEFAULT 0 NOT NULL,
  `shipping_address` text,
  `shipping_visible_from` text,
  `stripe_account_id` text,
  `stripe_charges_enabled` integer DEFAULT 0 NOT NULL,
  `stripe_payouts_enabled` integer DEFAULT 0 NOT NULL,
  `stripe_account_updated_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registry_items` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `kind` text DEFAULT 'product' NOT NULL,
  `title` text NOT NULL,
  `description` text,
  `image_key` text,
  `image_crop` text,
  `external_url` text,
  `price_minor` integer,
  `quantity_wanted` integer DEFAULT 1 NOT NULL,
  `allow_partial` integer DEFAULT 0 NOT NULL,
  `target_minor` integer,
  `category` text,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `registry_items_quantity_wanted_ck` CHECK (quantity_wanted >= 1),
  CONSTRAINT `registry_items_kind_ck` CHECK (kind in ('product','cash_fund'))
);
--> statement-breakpoint
CREATE TABLE `registry_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `item_id` text NOT NULL REFERENCES `registry_items`(`id`) ON DELETE CASCADE,
  `family_id` text NOT NULL REFERENCES `families`(`id`) ON DELETE CASCADE,
  `quantity` integer DEFAULT 1 NOT NULL,
  `status` text DEFAULT 'reserved' NOT NULL,
  `note` text,
  `display_name` text,
  `thanked_at` integer,
  `thanked_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `registry_claims_quantity_ck` CHECK (quantity >= 1 and quantity <= 99),
  CONSTRAINT `registry_claims_status_ck` CHECK (status in ('reserved','purchased','released'))
);
--> statement-breakpoint
CREATE TABLE `registry_contributions` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `item_id` text REFERENCES `registry_items`(`id`) ON DELETE SET NULL,
  `family_id` text NOT NULL REFERENCES `families`(`id`) ON DELETE CASCADE,
  `status` text DEFAULT 'pending' NOT NULL,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `primary_amount_minor` integer,
  `primary_currency` text,
  `fx_rate` text,
  `fx_rate_at` integer,
  `stripe_checkout_session_id` text NOT NULL UNIQUE,
  `stripe_payment_intent_id` text,
  `message` text,
  `display_name` text,
  `thanked_at` integer,
  `thanked_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `guests_family_id_sort_idx` ON `guests` (`family_id`, `sort_order`);
--> statement-breakpoint
CREATE UNIQUE INDEX `weddings_slug_unique` ON `weddings` (`slug`);
--> statement-breakpoint
CREATE INDEX `weddings_owner_idx` ON `weddings` (`owner_osn_profile_id`);
--> statement-breakpoint
CREATE INDEX `imports_wedding_uploaded_at_idx` ON `imports` (`wedding_id`,`uploaded_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_account_links_guest_uniq` ON `guest_account_links` (`guest_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_account_links_family_account_uniq` ON `guest_account_links` (`family_id`,`osn_account_id`);
--> statement-breakpoint
CREATE INDEX `guest_account_links_account_idx` ON `guest_account_links` (`osn_account_id`);
--> statement-breakpoint
CREATE INDEX `guest_account_links_family_idx` ON `guest_account_links` (`family_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_hosts_wedding_profile_uniq` ON `wedding_hosts` (`wedding_id`,`osn_profile_id`);
--> statement-breakpoint
CREATE INDEX `wedding_hosts_profile_idx` ON `wedding_hosts` (`osn_profile_id`);
--> statement-breakpoint
CREATE INDEX `wedding_hosts_wedding_idx` ON `wedding_hosts` (`wedding_id`);
--> statement-breakpoint
CREATE INDEX `events_wedding_id_sort_idx` ON `events` (`wedding_id`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `families_wedding_idx` ON `families` (`wedding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `families_one_host_per_wedding` ON `families` (`wedding_id`) WHERE `kind` = 'host';
--> statement-breakpoint
CREATE INDEX `tasks_wedding_bucket_sort_idx` ON `tasks` (`wedding_id`, `timeframe_bucket`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `budget_items_wedding_category_sort_idx` ON `budget_items` (`wedding_id`, `category`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `payments_item_idx` ON `payments` (`budget_item_id`);
--> statement-breakpoint
CREATE INDEX `directory_vendors_owner_idx` ON `directory_vendors` (`owner_org_id`);
--> statement-breakpoint
CREATE INDEX `vendors_wedding_status_idx` ON `vendors` (`wedding_id`, `status`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `vendor_claims_vendor_idx` ON `vendor_claims` (`directory_vendor_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_wedding_directory_uniq`
  ON `vendors` (`wedding_id`, `directory_vendor_id`)
  WHERE `directory_vendor_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_enquiries_wedding_directory_uniq` ON `vendor_enquiries` (`wedding_id`, `directory_vendor_id`);
--> statement-breakpoint
CREATE INDEX `vendor_enquiries_wedding_last_msg_idx` ON `vendor_enquiries` (`wedding_id`, `last_message_at`);
--> statement-breakpoint
CREATE INDEX `vendor_enquiries_directory_idx` ON `vendor_enquiries` (`directory_vendor_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organiser_sessions_token_unique` ON `organiser_sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `organiser_sessions_profile_idx` ON `organiser_sessions` (`osn_profile_id`);
--> statement-breakpoint
CREATE INDEX `organiser_sessions_expires_idx` ON `organiser_sessions` (`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_wedding_slug_unique` ON `events` (`wedding_id`, `slug`);
--> statement-breakpoint
CREATE INDEX `guest_events_event_id_idx` ON `guest_events` (`event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rsvps_guest_event_uniq` ON `rsvps` (`guest_id`, `event_id`);
--> statement-breakpoint
CREATE INDEX `rsvps_event_id_idx` ON `rsvps` (`event_id`);
--> statement-breakpoint
CREATE INDEX `sessions_family_idx` ON `sessions` (`family_id`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `weddings_created_at_idx` ON `weddings` (`created_at`);
--> statement-breakpoint
CREATE INDEX `directory_vendors_listed_name_idx` ON `directory_vendors` (`listed`, `name`, `id`);
--> statement-breakpoint
CREATE INDEX `registry_items_wedding_sort_idx` ON `registry_items` (`wedding_id`,`sort_order`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_claims_item_family_uniq` ON `registry_claims` (`item_id`,`family_id`);
--> statement-breakpoint
CREATE INDEX `registry_claims_wedding_created_idx` ON `registry_claims` (`wedding_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `registry_claims_item_status_idx` ON `registry_claims` (`item_id`,`status`,`family_id`,`quantity`);
--> statement-breakpoint
CREATE INDEX `registry_claims_wedding_item_status_idx` ON `registry_claims` (`wedding_id`,`item_id`,`status`,`quantity`);
--> statement-breakpoint
CREATE INDEX `registry_contributions_wedding_created_idx` ON `registry_contributions` (`wedding_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `registry_contributions_item_idx` ON `registry_contributions` (`item_id`);
