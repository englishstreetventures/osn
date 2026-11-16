CREATE TABLE `arc_outbound_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`public_key_jwk` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `app_outcomes` text;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `delete_everything` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `fanout_failed_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `deletion_jobs_pulse_pending_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `deletion_jobs_zap_pending_idx`;--> statement-breakpoint
CREATE INDEX `arc_outbound_keys_expires_idx` ON `arc_outbound_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `deletion_jobs_fanout_order_idx` ON `deletion_jobs` (`fanout_failed_at`,`hard_delete_at`);--> statement-breakpoint
-- A job that deletes everything holds no stored answers: the hard delete
-- would apply organisation answers and the fan-out send app answers beside
-- the flag. Two triggers refuse the pair on insert and on update; a CHECK
-- would need a copy-and-swap rebuild of the table. The column is new in this
-- file with a default of 0, so no stored row holds the pair.
CREATE TRIGGER IF NOT EXISTS `deletion_jobs_delete_everything_no_choices` BEFORE INSERT ON `deletion_jobs`
WHEN NEW.`delete_everything` = 1 AND NEW.`choices` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'a deletion job that deletes everything holds no choices');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `deletion_jobs_delete_everything_no_choices_update` BEFORE UPDATE OF `delete_everything`, `choices` ON `deletion_jobs`
WHEN NEW.`delete_everything` = 1 AND NEW.`choices` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'a deletion job that deletes everything holds no choices');
END;
