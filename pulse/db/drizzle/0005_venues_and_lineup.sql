CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`org_handle` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'club' NOT NULL,
	`description` text,
	`address` text,
	`city` text,
	`country` text,
	`latitude` real,
	`longitude` real,
	`capacity` integer,
	`hours` text,
	`hero_image_url` text,
	`website_url` text,
	`instagram_handle` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `venues_kind_idx` ON `venues` (`kind`);--> statement-breakpoint
CREATE INDEX `venues_lat_lng_idx` ON `venues` (`latitude`,`longitude`);--> statement-breakpoint
CREATE UNIQUE INDEX `venues_org_handle_idx` ON `venues` (`org_handle`,`handle`);--> statement-breakpoint
CREATE TABLE `event_lineup` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`artist_name` text NOT NULL,
	`role` text DEFAULT 'support' NOT NULL,
	`slot_start` integer NOT NULL,
	`slot_end` integer NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)
);
--> statement-breakpoint
CREATE INDEX `event_lineup_event_id_idx` ON `event_lineup` (`event_id`,`slot_start`);--> statement-breakpoint
ALTER TABLE `events` ADD `venue_id` text REFERENCES venues(id);--> statement-breakpoint
CREATE INDEX `events_venue_id_idx` ON `events` (`venue_id`,`start_time`);
