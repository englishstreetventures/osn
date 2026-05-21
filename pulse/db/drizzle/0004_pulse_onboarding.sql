CREATE TABLE `pulse_account_onboarding` (
	`account_id` text PRIMARY KEY NOT NULL,
	`completed_at` integer NOT NULL,
	`interests` text DEFAULT '[]' NOT NULL,
	`notifications_opt_in` integer DEFAULT false NOT NULL,
	`event_reminders_opt_in` integer DEFAULT false NOT NULL,
	`notifications_perm` text DEFAULT 'prompt' NOT NULL,
	`location_perm` text DEFAULT 'prompt' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pulse_profile_accounts` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pulse_profile_accounts_account_idx` ON `pulse_profile_accounts` (`account_id`);
