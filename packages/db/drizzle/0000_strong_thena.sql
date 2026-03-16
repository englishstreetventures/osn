CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`venue` text,
	`category` text,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`image_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_start_time_idx` ON `events` (`start_time`);