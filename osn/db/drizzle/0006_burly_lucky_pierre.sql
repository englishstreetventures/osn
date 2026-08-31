DROP INDEX `email_changes_account_idx`;--> statement-breakpoint
CREATE INDEX `email_changes_account_completed_at_idx` ON `email_changes` (`account_id`,`completed_at`);