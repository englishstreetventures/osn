CREATE TABLE `rotated_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`account_id` text NOT NULL,
	`rotated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_rotated_sessions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `rotated_sessions_expires_idx` ON `rotated_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `rotated_sessions_account_idx` ON `rotated_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `rotated_sessions_family_idx` ON `rotated_sessions` (`family_id`);