-- Soft delete for weddings. `deleted_at` (seconds) NULL means live; set, the
-- wedding is hidden everywhere except its owners' restore, and the daily purge
-- hard-deletes it once the restore window has passed. Two nullable columns
-- added in place, plus a partial index holding only deleted rows for the
-- purge's candidate read. No rebuild: every existing wedding reads NULL and
-- stays live.

ALTER TABLE `weddings` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `weddings` ADD `deleted_by_osn_profile_id` text;--> statement-breakpoint
CREATE INDEX `weddings_deleted_at_idx` ON `weddings` (`deleted_at`) WHERE deleted_at IS NOT NULL;
