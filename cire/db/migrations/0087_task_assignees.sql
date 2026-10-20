-- Checklist assignees. A task can be held by several seats of its wedding, or
-- by none: one task_assignees row per (task, seat). A seat (`wedding_hosts.id`),
-- not a profile id, because the helper run sheet filters on the seat.
--
-- `wedding_id` rides in both foreign keys, so an assignment can only pair a task
-- with a seat of the same wedding. Their parent keys need the two new UNIQUE
-- indexes on (id, wedding_id); SQLite checks a foreign key's parent index when a
-- row is written, not when the table is created, so the indexes may follow it.
-- Both keys cascade: deleting a task takes its assignments, and removing a seat
-- (or a co-host leaving) takes theirs and keeps the task.
--
-- Additive: a new table and new indexes, never a table rebuild. One hand edit
-- to what drizzle-kit wrote: it rebuilt `tasks` (copy, drop, rename) to add the
-- (id, wedding_id) unique index, and D1 enforces foreign keys, so that drop
-- would cascade. An index needs no rebuild. The SQL matches the Drizzle schema
-- and cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`).
CREATE TABLE `task_assignees` (
	`task_id` text NOT NULL,
	`host_id` text NOT NULL,
	`wedding_id` text NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `host_id`),
	FOREIGN KEY (`task_id`,`wedding_id`) REFERENCES `tasks`(`id`,`wedding_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`,`wedding_id`) REFERENCES `wedding_hosts`(`id`,`wedding_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_assignees_host_idx` ON `task_assignees` (`host_id`);--> statement-breakpoint
CREATE INDEX `task_assignees_wedding_assigned_idx` ON `task_assignees` (`wedding_id`,`assigned_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_wedding_unique` ON `tasks` (`id`,`wedding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_hosts_id_wedding_unique` ON `wedding_hosts` (`id`,`wedding_id`);