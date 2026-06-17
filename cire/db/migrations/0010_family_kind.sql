ALTER TABLE `families` ADD `kind` text DEFAULT 'guest' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `families_one_host_per_wedding` ON `families` (`wedding_id`) WHERE kind = 'host';
