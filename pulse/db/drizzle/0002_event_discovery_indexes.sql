DROP INDEX `events_visibility_idx`;--> statement-breakpoint
CREATE INDEX `events_visibility_start_time_idx` ON `events` (`visibility`,`start_time`);--> statement-breakpoint
CREATE INDEX `events_category_idx` ON `events` (`category`);--> statement-breakpoint
CREATE INDEX `events_lat_lng_idx` ON `events` (`latitude`,`longitude`);--> statement-breakpoint
CREATE INDEX `event_rsvps_profile_event_idx` ON `event_rsvps` (`profile_id`,`event_id`);