-- A redeemed vendor claim waits for an operator before it binds the listing.
-- Three nullable columns, so no row is rewritten; the unique index lets an org
-- hold at most one pending claim, and any number of rows hold NULL. The
-- partial index is the daily hand-off sweep's queue of buffered enquiries.

ALTER TABLE `directory_vendors` ADD `review_org_id` text;--> statement-breakpoint
ALTER TABLE `directory_vendors` ADD `review_profile_id` text;--> statement-breakpoint
ALTER TABLE `directory_vendors` ADD `review_requested_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `directory_vendors_review_org_uniq` ON `directory_vendors` (`review_org_id`);--> statement-breakpoint
CREATE INDEX `vendor_enquiries_buffered_idx` ON `vendor_enquiries` (`updated_at`,`id`) WHERE status = 'open' AND zap_chat_id IS NULL AND pending_body IS NOT NULL;