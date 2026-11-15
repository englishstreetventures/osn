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
CREATE INDEX `deletion_jobs_fanout_order_idx` ON `deletion_jobs` (`fanout_failed_at`,`hard_delete_at`);