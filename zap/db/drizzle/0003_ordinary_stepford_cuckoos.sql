DROP INDEX IF EXISTS `messages_chat_created_idx`;--> statement-breakpoint
CREATE INDEX `messages_chat_created_idx` ON `messages` (`chat_id`,`created_at`,`id`);