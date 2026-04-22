-- M-PK1b: out-of-band security event audit trail.
--
-- Captures account-level security actions (recovery-code regeneration +
-- consumption) so the client can surface a dismissible banner on behalf of
-- the account holder. `kind` is a bounded string enum enforced at the
-- service layer, not the column, so expanding the taxonomy does not
-- require another migration.
--
-- P-W1: partial index over the hot "unacknowledged" slice. Acked rows are
-- kept for audit but grow unbounded over time; the Settings banner only
-- reads unacked rows, so excluding acked rows from the index keeps it tiny
-- regardless of history size, and the (account_id, created_at) ordering
-- lets SQLite satisfy `ORDER BY created_at DESC` from the index.

CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`ip_hash` text,
	`ua_label` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `security_events_unacked_idx` ON `security_events` (`account_id`, `created_at`) WHERE `acknowledged_at` IS NULL;
