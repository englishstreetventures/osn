-- 0043_vendor_enquiries.sql — Vendors S4 enquiry backend (additive; no drops).
-- directory_vendors gains two nullable columns for lead forwarding + claim tracking.
ALTER TABLE `directory_vendors` ADD `lead_forward_email` text;
--> statement-breakpoint
ALTER TABLE `directory_vendors` ADD `claimed_by_profile_id` text;
--> statement-breakpoint
-- vendor_enquiries: one thread per (wedding, directory listing) — the c2b chat.
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
CREATE UNIQUE INDEX `vendor_enquiries_wedding_directory_uniq` ON `vendor_enquiries` (`wedding_id`, `directory_vendor_id`);
--> statement-breakpoint
CREATE INDEX `vendor_enquiries_wedding_last_msg_idx` ON `vendor_enquiries` (`wedding_id`, `last_message_at`);
--> statement-breakpoint
CREATE INDEX `vendor_enquiries_directory_idx` ON `vendor_enquiries` (`directory_vendor_id`);
