CREATE TABLE `guest_account_links` (
	`id` text PRIMARY KEY NOT NULL,
	`guest_id` text NOT NULL,
	`family_id` text NOT NULL,
	`wedding_id` text NOT NULL,
	`osn_account_id` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_account_links_guest_uniq` ON `guest_account_links` (`guest_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_account_links_family_account_uniq` ON `guest_account_links` (`family_id`,`osn_account_id`);--> statement-breakpoint
CREATE INDEX `guest_account_links_account_idx` ON `guest_account_links` (`osn_account_id`);--> statement-breakpoint
CREATE INDEX `guest_account_links_family_idx` ON `guest_account_links` (`family_id`);