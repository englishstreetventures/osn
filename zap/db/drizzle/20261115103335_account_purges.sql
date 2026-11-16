CREATE TABLE `zap_account_purges` (
	`account_id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL,
	`kept_messages` integer NOT NULL
);
