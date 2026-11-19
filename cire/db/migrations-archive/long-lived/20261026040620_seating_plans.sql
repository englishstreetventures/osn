-- Seating plans: several versions of one event's seating chart, one of them
-- selected. A table belongs to one plan, and a seat repeats its table's plan,
-- so "one seat per guest per plan" is a plain unique index.
--
-- `seating_plans` holds the plans. A partial unique index on `event_id` where
-- `selected = 1` refuses a second selected plan at one event.
--
-- Every event that already has tables gets one plan, "Plan 1", selected, with
-- an id minted here (`spl_` and 32 hex digits). Its tables and their seats move
-- into it. An event with no tables gets no plan; the API makes the first one
-- with the event's first table.
--
-- `seating_tables` gains `plan_id` by ADD COLUMN, never a rebuild: dropping
-- the table would cascade into its seats. SQLite adds a column with a foreign
-- key only when the column may be NULL, so it is nullable. The unique
-- `(plan_id, id)` index is the parent key of the seats' new foreign key, so it
-- is created before any statement writes a seat.
--
-- `seating_assignments` is copied and swapped, by hand: nothing references it,
-- so its DROP TABLE cascades nowhere, and a composite foreign key cannot be
-- added any other way. The copy takes each seat's `plan_id` from its table.
-- The new table adds the `(table_id, plan_id)` foreign key, which keeps a seat
-- in its table's plan, and swaps the unique `(event_id, guest_id)` index for a
-- unique `(plan_id, guest_id)` one and a plain `(event_id, guest_id)` one, the
-- probe the invitation's cascade reads. No PRAGMA foreign_keys line: SQLite
-- ignores one inside the transaction D1 runs a migration in, and nothing here
-- needs it.
--
-- The Worker before this migration writes tables and seats without naming
-- `plan_id`. Two triggers adopt such a row: a table goes into its event's
-- selected plan, which the trigger makes as "Plan 1" when the event has none,
-- and a seat takes its table's plan. The seat trigger's UPDATE is what the
-- composite key and the unique index check, so that Worker still cannot seat a
-- guest twice in one plan. On an event with one plan it reads and writes as it
-- always did; on one with more it reads and writes by event alone, which the
-- page wiki/cire/cire-seating.md describes with the check to run before
-- rolling back. The adopt triggers go, and `plan_id` stops taking NULL, once no
-- Worker before this migration can serve: englishstreetventures/osn#1658.
--
-- `seating_copy_budget` counts the tables and seats each wedding copies into
-- new plans on one UTC day, for the API's daily ceiling on copies.
--
-- Two more triggers keep a table in a plan of its own event and wedding, which
-- a foreign key added by ADD COLUMN cannot say: an insert or an update that
-- names a plan of another event is refused. They stay.
--
-- Written by hand (`db:generate --custom`), since `db:generate` refuses a
-- copy-and-swap; cire/db/src/schema.ts declares the same shape, less the four
-- triggers, and cire/api/src/db/setup.ts mirrors all of it.
CREATE TABLE `seating_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`wedding_id` text NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`selected` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`,`wedding_id`) REFERENCES `events`(`id`,`wedding_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seating_plans_event_id_uniq` ON `seating_plans` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `seating_plans_one_selected_per_event` ON `seating_plans` (`event_id`) WHERE selected = 1;--> statement-breakpoint
INSERT INTO `seating_plans` (`id`, `wedding_id`, `event_id`, `name`, `selected`, `created_at`, `updated_at`)
SELECT 'spl_' || lower(hex(randomblob(16))), `wedding_id`, `event_id`, 'Plan 1', 1, unixepoch(), unixepoch()
FROM `seating_tables`
GROUP BY `event_id`, `wedding_id`;--> statement-breakpoint
ALTER TABLE `seating_tables` ADD `plan_id` text REFERENCES seating_plans(id) ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX `seating_tables_plan_id_uniq` ON `seating_tables` (`plan_id`,`id`);--> statement-breakpoint
UPDATE `seating_tables` SET `plan_id` = (
	SELECT `seating_plans`.`id` FROM `seating_plans`
	WHERE `seating_plans`.`event_id` = `seating_tables`.`event_id` AND `seating_plans`.`selected` = 1
);--> statement-breakpoint
CREATE TABLE `__new_seating_assignments` (
	`table_id` text NOT NULL,
	`plan_id` text,
	`event_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`table_id`, `guest_id`),
	FOREIGN KEY (`table_id`,`event_id`) REFERENCES `seating_tables`(`id`,`event_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`,`plan_id`) REFERENCES `seating_tables`(`id`,`plan_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guest_id`,`event_id`) REFERENCES `guest_events`(`guest_id`,`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_seating_assignments`("table_id", "plan_id", "event_id", "guest_id", "created_at")
SELECT `seating_assignments`.`table_id`, `seating_tables`.`plan_id`, `seating_assignments`.`event_id`, `seating_assignments`.`guest_id`, `seating_assignments`.`created_at`
FROM `seating_assignments`
INNER JOIN `seating_tables` ON `seating_tables`.`id` = `seating_assignments`.`table_id`;--> statement-breakpoint
DROP TABLE `seating_assignments`;--> statement-breakpoint
ALTER TABLE `__new_seating_assignments` RENAME TO `seating_assignments`;--> statement-breakpoint
CREATE UNIQUE INDEX `seating_assignments_plan_guest_uniq` ON `seating_assignments` (`plan_id`,`guest_id`);--> statement-breakpoint
CREATE INDEX `seating_assignments_event_guest_idx` ON `seating_assignments` (`event_id`,`guest_id`);--> statement-breakpoint
CREATE TRIGGER `seating_tables_adopt_plan` AFTER INSERT ON `seating_tables`
WHEN NEW.`plan_id` IS NULL
BEGIN
	INSERT INTO `seating_plans` (`id`, `wedding_id`, `event_id`, `name`, `selected`, `created_at`, `updated_at`)
	SELECT 'spl_' || lower(hex(randomblob(16))), NEW.`wedding_id`, NEW.`event_id`, 'Plan 1', 1, NEW.`created_at`, NEW.`created_at`
	WHERE NOT EXISTS (
		SELECT 1 FROM `seating_plans` WHERE `event_id` = NEW.`event_id` AND `selected` = 1
	);
	UPDATE `seating_tables` SET `plan_id` = (
		SELECT `id` FROM `seating_plans` WHERE `event_id` = NEW.`event_id` AND `selected` = 1
	)
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `seating_assignments_adopt_plan` AFTER INSERT ON `seating_assignments`
WHEN NEW.`plan_id` IS NULL
BEGIN
	UPDATE `seating_assignments` SET `plan_id` = (
		SELECT `plan_id` FROM `seating_tables` WHERE `id` = NEW.`table_id`
	)
	WHERE `table_id` = NEW.`table_id` AND `guest_id` = NEW.`guest_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `seating_tables_plan_at_event` BEFORE INSERT ON `seating_tables`
WHEN NEW.`plan_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `seating_plans`
	WHERE `id` = NEW.`plan_id` AND `event_id` = NEW.`event_id` AND `wedding_id` = NEW.`wedding_id`
)
BEGIN
	SELECT RAISE(ABORT, 'seating table plan is not a plan of its event');
END;--> statement-breakpoint
CREATE TRIGGER `seating_tables_plan_at_event_update` BEFORE UPDATE OF `plan_id`, `event_id`, `wedding_id` ON `seating_tables`
WHEN NEW.`plan_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `seating_plans`
	WHERE `id` = NEW.`plan_id` AND `event_id` = NEW.`event_id` AND `wedding_id` = NEW.`wedding_id`
)
BEGIN
	SELECT RAISE(ABORT, 'seating table plan is not a plan of its event');
END;--> statement-breakpoint
CREATE TABLE `seating_copy_budget` (
	`wedding_id` text NOT NULL,
	`day` text NOT NULL,
	`copied` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `seating_copy_budget_pk` PRIMARY KEY(`day`, `wedding_id`),
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seating_copy_budget_wedding_idx` ON `seating_copy_budget` (`wedding_id`);
