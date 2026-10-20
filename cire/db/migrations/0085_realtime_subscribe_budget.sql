-- The realtime subscribe budget: admitted subscribes per organiser per UTC
-- day, read by every Worker isolate. Keyed on the opaque OSN profile id, with
-- no foreign key, like owner_notice_budget's actor keys. `day` leads the key,
-- so deleting earlier days (each subscribe, and the daily cron) reads only the
-- rows it removes.
CREATE TABLE `realtime_subscribe_budget` (
	`osn_profile_id` text NOT NULL,
	`day` text NOT NULL,
	`subscribes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `osn_profile_id`)
);
