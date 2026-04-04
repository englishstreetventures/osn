PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`(`id`, `handle`, `email`, `display_name`, `avatar_url`, `created_at`, `updated_at`)
	SELECT `id`, COALESCE(`handle`, 'usr_' || substr(`id`, 5)), `email`, `display_name`, `avatar_url`, `created_at`, `updated_at`
	FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);
