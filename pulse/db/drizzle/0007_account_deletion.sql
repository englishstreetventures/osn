-- C-H2 Flow B — Pulse-side leave-app deletion plumbing.
--
-- 1. Host-cancellation lifecycle on `events`. When a host leaves Pulse,
--    their hosted events flip to a public "cancelled" state for 14 days,
--    then the event-cancellation sweeper hard-deletes them.
-- 2. `pulse_deletion_jobs` — one row per Pulse soft-delete, keyed by
--    `profile_id`. Mirrors the OSN-side `deletion_jobs` but scoped to
--    Pulse. `account_id` is a cross-DB reference to osn-db.accounts.id
--    used by the ARC callback that flips `app_enrollments.left_at`.

ALTER TABLE `events` ADD COLUMN `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `hard_delete_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `cancellation_reason` text;--> statement-breakpoint
CREATE INDEX `events_hard_delete_idx` ON `events` (`hard_delete_at`);--> statement-breakpoint

CREATE TABLE `pulse_deletion_jobs` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`soft_deleted_at` integer NOT NULL,
	`hard_delete_at` integer NOT NULL,
	`enrollment_notify_done_at` integer,
	`reason` text DEFAULT 'user_request' NOT NULL
);--> statement-breakpoint
CREATE INDEX `pulse_deletion_jobs_hard_delete_idx` ON `pulse_deletion_jobs` (`hard_delete_at`);--> statement-breakpoint
CREATE INDEX `pulse_deletion_jobs_account_idx` ON `pulse_deletion_jobs` (`account_id`);--> statement-breakpoint

-- 3. `pulse_account_purges` — S-H1 replay-protection ledger for the
--    ARC-gated `/internal/account-deleted` endpoint. One row per accountId
--    seen; subsequent calls with the same accountId short-circuit to no-op.
CREATE TABLE `pulse_account_purges` (
	`account_id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL,
	`profile_count` integer NOT NULL
);--> statement-breakpoint

-- 4. Erasure sweeps delete event_comms rows by sender; without this index
--    each per-row sweeper transaction full-scans a hot growing table while
--    holding the write lock (P-W1, post-merge re-review).
CREATE INDEX `event_comms_sent_by_idx` ON `event_comms` (`sent_by_profile_id`);
