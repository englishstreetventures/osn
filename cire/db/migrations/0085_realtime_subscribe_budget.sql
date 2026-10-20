-- The realtime subscribe budget: admitted subscribes per organiser per UTC
-- day, read by every Worker isolate. Keyed on the opaque OSN profile id, with
-- no foreign key, like owner_notice_budget's actor keys. Each subscribe deletes
-- the rows of earlier days, through the `day` index, so the table holds at most
-- one row per organiser who subscribed today.
CREATE TABLE `realtime_subscribe_budget` (
	`osn_profile_id` text NOT NULL,
	`day` text NOT NULL,
	`subscribes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`osn_profile_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `realtime_subscribe_budget_day_idx` ON `realtime_subscribe_budget` (`day`);
