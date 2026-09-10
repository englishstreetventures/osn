ALTER TABLE `rsvps` ADD `dietary` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `rsvps_guest_event_uniq` ON `rsvps` (`guest_id`, `event_id`);
