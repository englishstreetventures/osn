CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`passkey_user_id` text NOT NULL,
	`max_profiles` integer DEFAULT 5 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`processing_restricted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_unique` ON `accounts` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_passkey_user_id_unique` ON `accounts` (`passkey_user_id`);--> statement-breakpoint
CREATE TABLE `app_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`app` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_enrollments_account_idx` ON `app_enrollments` (`account_id`);--> statement-breakpoint
CREATE INDEX `app_enrollments_active_idx` ON `app_enrollments` (`account_id`,`app`) WHERE "app_enrollments"."left_at" IS NULL;--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `blocks_blocker_idx` ON `blocks` (`blocker_id`);--> statement-breakpoint
CREATE INDEX `blocks_blocked_idx` ON `blocks` (`blocked_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_pair_idx` ON `blocks` (`blocker_id`,`blocked_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`addressee_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`addressee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connections_requester_idx` ON `connections` (`requester_id`);--> statement-breakpoint
CREATE INDEX `connections_addressee_idx` ON `connections` (`addressee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_pair_idx` ON `connections` (`requester_id`,`addressee_id`);--> statement-breakpoint
CREATE TABLE `deletion_jobs` (
	`account_id` text PRIMARY KEY NOT NULL,
	`soft_deleted_at` integer NOT NULL,
	`hard_delete_at` integer NOT NULL,
	`pulse_done_at` integer,
	`zap_done_at` integer,
	`reason` text DEFAULT 'user_request' NOT NULL,
	`cancel_session_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deletion_jobs_hard_delete_idx` ON `deletion_jobs` (`hard_delete_at`);--> statement-breakpoint
CREATE INDEX `deletion_jobs_pulse_pending_idx` ON `deletion_jobs` (`soft_deleted_at`) WHERE "deletion_jobs"."pulse_done_at" IS NULL;--> statement-breakpoint
CREATE INDEX `deletion_jobs_zap_pending_idx` ON `deletion_jobs` (`soft_deleted_at`) WHERE "deletion_jobs"."zap_done_at" IS NULL;--> statement-breakpoint
CREATE TABLE `email_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`previous_email` text NOT NULL,
	`new_email` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_changes_account_idx` ON `email_changes` (`account_id`);--> statement-breakpoint
CREATE INDEX `email_changes_completed_at_idx` ON `email_changes` (`completed_at`);--> statement-breakpoint
CREATE TABLE `organisation_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `org_members_org_idx` ON `organisation_members` (`organisation_id`);--> statement-breakpoint
CREATE INDEX `org_members_profile_idx` ON `organisation_members` (`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_members_pair_idx` ON `organisation_members` (`organisation_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`avatar_url` text,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organisations_handle_unique` ON `organisations` (`handle`);--> statement-breakpoint
CREATE INDEX `organisations_owner_idx` ON `organisations` (`owner_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	`label` text,
	`last_used_at` integer,
	`aaguid` text,
	`backup_eligible` integer,
	`backup_state` integer,
	`updated_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_account_id_idx` ON `passkeys` (`account_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_codes_code_hash_unique` ON `recovery_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `recovery_codes_account_idx` ON `recovery_codes` (`account_id`);--> statement-breakpoint
CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`ip_hash` text,
	`ua_label` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `security_events_unacked_idx` ON `security_events` (`account_id`,`created_at`) WHERE "security_events"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE TABLE `service_account_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`public_key_jwk` text NOT NULL,
	`registered_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `service_accounts`(`service_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `service_account_keys_service_idx` ON `service_account_keys` (`service_id`);--> statement-breakpoint
CREATE TABLE `service_accounts` (
	`service_id` text PRIMARY KEY NOT NULL,
	`allowed_scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`family_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`ua_label` text,
	`ip_hash` text,
	`last_used_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_account_idx` ON `sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `sessions_family_idx` ON `sessions` (`family_id`);--> statement-breakpoint
CREATE INDEX `sessions_account_last_used_idx` ON `sessions` (`account_id`,`last_used_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX `users_account_idx` ON `users` (`account_id`);