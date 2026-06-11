-- C-H2: Right-to-erasure plumbing (GDPR Art. 17).
--
-- 1. Soft-delete tombstone columns on `accounts` so a deleted-but-not-yet-
--    purged account can be recognised on auth (block tokens) and during the
--    7-day grace window. `processing_restricted_at` is the Art. 18 hook —
--    not exercised yet, but the column is added in the same migration so
--    we don't need to migrate twice.
-- 2. `app_enrollments` — modular-platform opt-in tracking. Every Pulse /
--    Zap interaction lazily inserts a row; OSN-level deletion fan-out
--    only calls bridges where a row exists with `left_at IS NULL`.
-- 3. `deletion_jobs` — one row per in-flight soft-delete. Hard-delete
--    sweeper joins on `hard_delete_at <= now AND *_done_at NOT NULL`.

ALTER TABLE `accounts` ADD COLUMN `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD COLUMN `processing_restricted_at` integer;--> statement-breakpoint

CREATE TABLE `app_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`app` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `app_enrollments_account_idx` ON `app_enrollments` (`account_id`);--> statement-breakpoint
CREATE INDEX `app_enrollments_active_idx` ON `app_enrollments` (`account_id`, `app`) WHERE `left_at` IS NULL;--> statement-breakpoint

CREATE TABLE `deletion_jobs` (
	`account_id` text PRIMARY KEY NOT NULL,
	`soft_deleted_at` integer NOT NULL,
	`hard_delete_at` integer NOT NULL,
	`pulse_done_at` integer,
	`zap_done_at` integer,
	`reason` text DEFAULT 'user_request' NOT NULL,
	`cancel_session_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `deletion_jobs_hard_delete_idx` ON `deletion_jobs` (`hard_delete_at`);--> statement-breakpoint
CREATE INDEX `deletion_jobs_pulse_pending_idx` ON `deletion_jobs` (`soft_deleted_at`) WHERE `pulse_done_at` IS NULL;--> statement-breakpoint
CREATE INDEX `deletion_jobs_zap_pending_idx` ON `deletion_jobs` (`soft_deleted_at`) WHERE `zap_done_at` IS NULL;
