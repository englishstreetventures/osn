CREATE TABLE `pulse_close_friends` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`friend_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pulse_close_friends_pair_idx` ON `pulse_close_friends` (`profile_id`,`friend_id`);--> statement-breakpoint
CREATE INDEX `pulse_close_friends_profile_idx` ON `pulse_close_friends` (`profile_id`);--> statement-breakpoint
CREATE INDEX `pulse_close_friends_friend_idx` ON `pulse_close_friends` (`friend_id`);
