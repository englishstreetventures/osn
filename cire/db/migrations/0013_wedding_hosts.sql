CREATE TABLE `wedding_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`added_by_osn_profile_id` text NOT NULL,
	`role` text DEFAULT 'host' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_hosts_wedding_profile_uniq` ON `wedding_hosts` (`wedding_id`,`osn_profile_id`);--> statement-breakpoint
CREATE INDEX `wedding_hosts_profile_idx` ON `wedding_hosts` (`osn_profile_id`);--> statement-breakpoint
CREATE INDEX `wedding_hosts_wedding_idx` ON `wedding_hosts` (`wedding_id`);
