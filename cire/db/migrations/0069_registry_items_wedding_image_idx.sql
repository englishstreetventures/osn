-- Lets "does an item of this wedding name this image?" read one index entry
-- instead of every item of the wedding. The public gift-image route asks it on
-- every request that reaches the Worker; removing an item asks it to decide
-- whether the image's R2 object is orphaned.

CREATE INDEX `registry_items_wedding_image_idx` ON `registry_items` (`wedding_id`,`image_key`);
