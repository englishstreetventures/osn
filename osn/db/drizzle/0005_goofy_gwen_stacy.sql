PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_email_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`previous_email` text NOT NULL,
	`new_email` text NOT NULL,
	`completed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_email_changes`("id", "account_id", "previous_email", "new_email", "completed_at") SELECT "id", "account_id", "previous_email", "new_email", "completed_at" FROM `email_changes`;--> statement-breakpoint
DROP TABLE `email_changes`;--> statement-breakpoint
ALTER TABLE `__new_email_changes` RENAME TO `email_changes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `email_changes_account_idx` ON `email_changes` (`account_id`);--> statement-breakpoint
CREATE INDEX `email_changes_completed_at_idx` ON `email_changes` (`completed_at`);--> statement-breakpoint
CREATE TABLE `__new_security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`ip_hash` text,
	`ua_label` text
);
--> statement-breakpoint
INSERT INTO `__new_security_events`("id", "account_id", "kind", "created_at", "acknowledged_at", "ip_hash", "ua_label") SELECT "id", "account_id", "kind", "created_at", "acknowledged_at", "ip_hash", "ua_label" FROM `security_events`;--> statement-breakpoint
DROP TABLE `security_events`;--> statement-breakpoint
ALTER TABLE `__new_security_events` RENAME TO `security_events`;--> statement-breakpoint
CREATE INDEX `security_events_unacked_idx` ON `security_events` (`account_id`,`created_at`) WHERE "security_events"."acknowledged_at" IS NULL;