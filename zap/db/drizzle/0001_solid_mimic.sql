PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sender_profile_id` text NOT NULL,
	`ciphertext` text,
	`nonce` text,
	`body` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "chat_id", "sender_profile_id", "ciphertext", "nonce", "body", "created_at", "expires_at") SELECT "id", "chat_id", "sender_profile_id", "ciphertext", "nonce", NULL, "created_at", "expires_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `messages_chat_idx` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `messages_chat_created_idx` ON `messages` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_sender_idx` ON `messages` (`sender_profile_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `class` text DEFAULT 'c2c' NOT NULL;--> statement-breakpoint
CREATE INDEX `chats_class_idx` ON `chats` (`class`);