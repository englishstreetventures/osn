-- 0057_registry.sql — gift registry (additive; no drops).
--
-- Everything here is gated by the `registry` entitlement, which is granted to
-- no wedding, so these tables stay empty in production until someone grants it.
--
-- MONEY: the wedding has ONE primary currency (`weddings.currency`) and every
-- figure the organiser authors is denominated in it — `registry_items` has no
-- currency column on purpose. Only RECEIVED money can be foreign, and
-- `registry_contributions` carries both the as-given amount and its
-- primary-currency equivalent, each snapshotted once.
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
);--> statement-breakpoint
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
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `registry_items_wedding_sort_idx` ON `registry_items` (`wedding_id`,`sort_order`);--> statement-breakpoint
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
  `updated_at` integer NOT NULL
);--> statement-breakpoint
-- One claim row per (item, household): re-claiming UPDATES rather than stacking
-- rows, which is what keeps the remaining-quantity arithmetic tractable.
CREATE UNIQUE INDEX `registry_claims_item_family_uniq` ON `registry_claims` (`item_id`,`family_id`);--> statement-breakpoint
CREATE INDEX `registry_claims_wedding_created_idx` ON `registry_claims` (`wedding_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `registry_claims_item_status_idx` ON `registry_claims` (`item_id`,`status`);--> statement-breakpoint
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
);--> statement-breakpoint
CREATE INDEX `registry_contributions_wedding_created_idx` ON `registry_contributions` (`wedding_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `registry_contributions_item_idx` ON `registry_contributions` (`item_id`);--> statement-breakpoint
-- Guest-facing section copy. All NULL on every existing row ⇒ the built-in
-- defaults, so no invite changes until an organiser edits them.
ALTER TABLE `wedding_invite_customisations` ADD `registry_eyebrow` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `registry_heading` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `registry_body` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `registry_tone` text;
