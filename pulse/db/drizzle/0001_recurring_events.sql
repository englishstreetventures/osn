CREATE TABLE `event_series` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`venue` text,
	`latitude` real,
	`longitude` real,
	`category` text,
	`image_url` text,
	`duration_minutes` integer,
	`visibility` text DEFAULT 'public' NOT NULL,
	`guest_list_visibility` text DEFAULT 'public' NOT NULL,
	`join_policy` text DEFAULT 'open' NOT NULL,
	`allow_interested` integer DEFAULT true NOT NULL,
	`comms_channels` text DEFAULT '["email"]' NOT NULL,
	`rrule` text NOT NULL,
	`dtstart` integer NOT NULL,
	`until` integer,
	`materialized_through` integer NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`chat_id` text,
	`created_by_profile_id` text NOT NULL,
	`created_by_name` text,
	`created_by_avatar` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_series_created_by_idx` ON `event_series` (`created_by_profile_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `series_id` text REFERENCES event_series(id);--> statement-breakpoint
ALTER TABLE `events` ADD `instance_override` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `events_series_id_idx` ON `events` (`series_id`,`start_time`);
