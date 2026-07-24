CREATE TABLE `oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`account_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`code_challenge` text NOT NULL,
	`nonce` text,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expires_idx` ON `oauth_authorization_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`logo_url` text,
	`redirect_uris` text NOT NULL,
	`client_secret_hash` text,
	`sector_identifier` text NOT NULL,
	`allowed_scopes` text DEFAULT 'openid profile email' NOT NULL,
	`is_first_party` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_unique` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_clients_sector_idx` ON `oauth_clients` (`sector_identifier`);--> statement-breakpoint
CREATE TABLE `oauth_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`client_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`scope` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_consents_account_client_uq` ON `oauth_consents` (`account_id`,`client_id`);