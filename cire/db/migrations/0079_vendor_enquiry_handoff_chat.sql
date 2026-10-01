-- The chat a failed buffered-enquiry hand-off provisioned, kept so the retry
-- reuses it rather than provisioning another. One nullable column: no row is
-- rewritten.

ALTER TABLE `vendor_enquiries` ADD `handoff_chat_id` text;
