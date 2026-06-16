CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`event_id` text,
	`created_by_profile_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chats_type_idx` ON `chats` (`type`);--> statement-breakpoint
CREATE INDEX `chats_event_id_idx` ON `chats` (`event_id`);--> statement-breakpoint
CREATE INDEX `chats_created_by_profile_id_idx` ON `chats` (`created_by_profile_id`);--> statement-breakpoint
CREATE TABLE `chat_members` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_members_chat_idx` ON `chat_members` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_members_profile_idx` ON `chat_members` (`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_members_pair_idx` ON `chat_members` (`chat_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sender_profile_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_chat_idx` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `messages_chat_created_idx` ON `messages` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_sender_idx` ON `messages` (`sender_profile_id`);