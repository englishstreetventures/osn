-- The chat a buffered-enquiry hand-off provisioned but has not yet recorded as
-- delivered, so a retry reuses it rather than provisioning another. One
-- nullable column: no row is rewritten.

ALTER TABLE `vendor_enquiries` ADD `handoff_chat_id` text;
