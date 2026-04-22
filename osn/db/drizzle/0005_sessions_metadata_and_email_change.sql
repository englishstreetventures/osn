-- Phase 5a auth improvements — Copenhagen Book extensions:
--   • Session introspection: per-session metadata (UA, IP-hash, last-used) powers
--     the Settings → Sessions panel and per-device revoke.
--   • Email-change audit trail: `email_changes` captures every completed change
--     so we can enforce the "2 changes per 7 days" cap and surface history to the
--     user. Previous email stays on the row for audit (never exposed over the wire).

ALTER TABLE `sessions` ADD `ua_label` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_used_at` integer;--> statement-breakpoint

CREATE TABLE `email_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`previous_email` text NOT NULL,
	`new_email` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `email_changes_account_idx` ON `email_changes` (`account_id`);--> statement-breakpoint
CREATE INDEX `email_changes_completed_at_idx` ON `email_changes` (`completed_at`);--> statement-breakpoint

-- P-W2: composite index so `listAccountSessions`'s ORDER BY last_used_at DESC
-- is served from the index rather than an in-memory sort. Also serves the
-- LRU eviction scan in `issueTokens` (same ORDER BY).
CREATE INDEX `sessions_account_last_used_idx` ON `sessions` (`account_id`, `last_used_at`);
