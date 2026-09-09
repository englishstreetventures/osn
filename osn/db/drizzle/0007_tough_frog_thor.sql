CREATE TABLE `totp_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`secret_ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`label` text,
	`confirmed_at` integer,
	`last_used_at` integer,
	`last_used_step` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `totp_credentials_account_idx` ON `totp_credentials` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `totp_credentials_account_confirmed_idx` ON `totp_credentials` (`account_id`) WHERE "totp_credentials"."confirmed_at" is not null;