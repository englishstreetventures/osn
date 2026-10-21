-- An event's run of show, getting-there notes and guest policy, which the
-- invited household reads on the event's details sheet. The organiser writes
-- them in the event drawer or the events sheet.
--
-- run_of_show_items: one row per item of an event's timed list. `time` is a
-- 24-hour wall clock (HH:MM) in the event's own zone; `sort_order` is the
-- organiser's order, and the list is replaced whole on every write, so the
-- primary key is (event_id, sort_order). `wedding_id` is held equal to the
-- event's by the composite foreign key onto events_id_wedding_uniq, as
-- seating_tables does; the rows go with their event.
--
-- events: four nullable columns, ALTER TABLE ADD, never a table rebuild, no
-- back-fill. NULL means none, or "not stated" for the two presets.
CREATE TABLE `run_of_show_items` (
	`event_id` text NOT NULL,
	`wedding_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`time` text NOT NULL,
	`label` text NOT NULL,
	PRIMARY KEY(`event_id`, `sort_order`),
	FOREIGN KEY (`event_id`,`wedding_id`) REFERENCES `events`(`id`,`wedding_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `events` ADD `getting_there` text;--> statement-breakpoint
ALTER TABLE `events` ADD `children_policy` text;--> statement-breakpoint
ALTER TABLE `events` ADD `plus_one_policy` text;--> statement-breakpoint
ALTER TABLE `events` ADD `guest_policy_note` text;