CREATE TABLE `families` (
  `id` text PRIMARY KEY NOT NULL,
  `public_id` text NOT NULL,
  `family_name` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `families_public_id_unique` ON `families` (`public_id`);
--> statement-breakpoint
CREATE INDEX `families_family_name_idx` ON `families` (`family_name`);
--> statement-breakpoint
CREATE TABLE `guests` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `first_name` text NOT NULL,
  `last_name` text DEFAULT '' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `guests_family_id_idx` ON `guests` (`family_id`);
--> statement-breakpoint
CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `date` text NOT NULL,
  `location` text NOT NULL,
  `description` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);
--> statement-breakpoint
CREATE TABLE `guest_events` (
  `guest_id` text NOT NULL,
  `event_id` text NOT NULL,
  PRIMARY KEY (`guest_id`, `event_id`),
  FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `guest_events_event_id_idx` ON `guest_events` (`event_id`);
--> statement-breakpoint
CREATE TABLE `rsvps` (
  `id` text PRIMARY KEY NOT NULL,
  `guest_id` text NOT NULL,
  `event_id` text NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `token` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);
