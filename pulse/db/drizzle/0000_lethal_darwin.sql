CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`venue` text,
	`latitude` real,
	`longitude` real,
	`category` text,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`image_url` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`guest_list_visibility` text DEFAULT 'public' NOT NULL,
	`join_policy` text DEFAULT 'open' NOT NULL,
	`allow_interested` integer DEFAULT true NOT NULL,
	`comms_channels` text DEFAULT '["email"]' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_by_name` text,
	`created_by_avatar` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_start_time_idx` ON `events` (`start_time`);--> statement-breakpoint
CREATE INDEX `events_created_by_user_id_idx` ON `events` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `events_visibility_idx` ON `events` (`visibility`);--> statement-breakpoint
CREATE TABLE `event_rsvps` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'going' NOT NULL,
	`invited_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_rsvps_event_idx` ON `event_rsvps` (`event_id`);--> statement-breakpoint
CREATE INDEX `event_rsvps_user_idx` ON `event_rsvps` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_rsvps_pair_idx` ON `event_rsvps` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `pulse_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`attendance_visibility` text DEFAULT 'connections' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_comms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`channel` text NOT NULL,
	`body` text NOT NULL,
	`sent_by_user_id` text NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_comms_event_idx` ON `event_comms` (`event_id`);