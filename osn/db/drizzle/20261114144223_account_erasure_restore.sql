CREATE TABLE `handle_holds` (
	`handle` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`release_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_handle_holds_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT "handle_holds_state_ck" CHECK((account_id IS NULL) <> (release_at IS NULL)),
	CONSTRAINT "handle_holds_handle_ck" CHECK(length(handle) = 64)
);
--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `restore` text;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `choices` text;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `hard_delete_failed_at` integer;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `job_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `org_members_org_idx`;--> statement-breakpoint
CREATE INDEX `handle_holds_account_idx` ON `handle_holds` (`account_id`);--> statement-breakpoint
CREATE INDEX `handle_holds_release_idx` ON `handle_holds` (`release_at`);--> statement-breakpoint
CREATE INDEX `org_members_succession_idx` ON `organisation_members` (`organisation_id`,`role`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `security_events_created_at_idx` ON `security_events` (`created_at`);