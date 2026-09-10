-- 0040_vendors.sql — Vendors Slice 1 foundation (additive; no drops).
-- directory_vendors: the global business listing (one per OSN org).
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
);
--> statement-breakpoint
CREATE INDEX `directory_vendors_owner_idx` ON `directory_vendors` (`owner_org_id`);
--> statement-breakpoint
-- directory_vendor_categories: many service categories per listing.
CREATE TABLE `directory_vendor_categories` (
  `directory_vendor_id` text NOT NULL REFERENCES `directory_vendors`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  PRIMARY KEY (`directory_vendor_id`, `category`)
);
--> statement-breakpoint
CREATE INDEX `directory_vendor_categories_category_idx` ON `directory_vendor_categories` (`category`);
--> statement-breakpoint
-- vendors: the wedding-scoped CRM row (organiser-private).
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
CREATE INDEX `vendors_wedding_status_idx` ON `vendors` (`wedding_id`, `status`, `sort_order`);
--> statement-breakpoint
-- vendor_claims: email-verification claim tokens (SHA-256 hashed, single-use, TTL).
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
CREATE INDEX `vendor_claims_vendor_idx` ON `vendor_claims` (`directory_vendor_id`);
