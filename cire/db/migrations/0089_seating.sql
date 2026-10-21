-- Seating: tables at an event, and which guest sits at which table.
-- Two new tables and one index on events; no table is rebuilt.
-- events gains a unique (id, wedding_id) index: unique already, since id is,
-- but SQLite only accepts a foreign key whose parent columns carry one. It is
-- the parent key that ties a seating table's wedding to its event's.
-- seating_assignments repeats its table's event_id so that one seat per guest
-- per event is a plain unique index; the (table_id, event_id) foreign key keeps
-- the copy equal to the table's event, and the (guest_id, event_id) foreign
-- key admits only an invited guest and removes the seat with the invitation.
CREATE UNIQUE INDEX `events_id_wedding_uniq` ON `events` (`id`,`wedding_id`);--> statement-breakpoint
CREATE TABLE `seating_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`,`wedding_id`) REFERENCES `events`(`id`,`wedding_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seating_tables_event_id_uniq` ON `seating_tables` (`event_id`,`id`);--> statement-breakpoint
CREATE TABLE `seating_assignments` (
	`table_id` text NOT NULL,
	`event_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`table_id`, `guest_id`),
	FOREIGN KEY (`table_id`,`event_id`) REFERENCES `seating_tables`(`id`,`event_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guest_id`,`event_id`) REFERENCES `guest_events`(`guest_id`,`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seating_assignments_event_guest_uniq` ON `seating_assignments` (`event_id`,`guest_id`);
