-- Enquiry inboxes page by (last_message_at, id), newest first. Both indexes
-- end in those two columns, so a page cursor seeks straight to the next page
-- and the read stops at the page size instead of sorting every row.
-- The couple index keeps its name and gains `id`; the vendor side's
-- single-column `directory_vendor_id` index is replaced by a composite whose
-- prefix still serves any lookup of a listing's enquiries.
DROP INDEX `vendor_enquiries_directory_idx`;--> statement-breakpoint
DROP INDEX `vendor_enquiries_wedding_last_msg_idx`;--> statement-breakpoint
CREATE INDEX `vendor_enquiries_directory_last_msg_idx` ON `vendor_enquiries` (`directory_vendor_id`,`last_message_at`,`id`);--> statement-breakpoint
CREATE INDEX `vendor_enquiries_wedding_last_msg_idx` ON `vendor_enquiries` (`wedding_id`,`last_message_at`,`id`);