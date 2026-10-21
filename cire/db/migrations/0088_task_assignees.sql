-- Checklist holders. A task can be held by several seats of its wedding, or
-- by none: one task_assignees row per (task, seat). A seat (`wedding_hosts.id`),
-- not a profile id, because the helper run sheet filters on the seat.
--
-- `wedding_id` rides in both foreign keys, so an assignment can only pair a task
-- with a seat of the same wedding. Their parent keys are the two new UNIQUE
-- indexes on (id, wedding_id). SQLite checks a foreign key's parent index when a
-- row is written, not when the table is created, so the indexes may follow the
-- table but must come before the copy below. Both keys cascade: deleting a task
-- takes its assignments, and removing a seat (or a co-host leaving) takes theirs
-- and keeps the task.
--
-- Each task_assignees index leads with the equalities of the reads it serves —
-- (host_id, wedding_id) for the seat cascade, (wedding_id, task_id) for a task's
-- holders and the task cascade — because D1 keeps no planner statistics, and
-- without them an index led by wedding_id alone would win every tie and walk
-- the whole wedding's assignments.
--
-- The last statement copies 0087's single assignee across: one row for every
-- task whose `assigned_host_id` names a seat of the task's own wedding, stamped
-- with the time the migration runs. A value naming another wedding's seat is
-- left behind, since the composite keys would refuse it.
--
-- `tasks.assigned_host_id` and its index stay. The Worker this migration ships
-- under no longer names the column, but every deploy migrates before the new
-- Worker serves and a failed smoke check rolls the Worker back without undoing
-- the migration, so the Worker before it, which reads and writes the column,
-- must keep working (wiki/shared/production-deploy.md §4). The values stay too,
-- so that Worker still sees its assignments after a rollback. The column goes
-- in a later release: englishstreetventures/osn#1636.
--
-- Additive: a new table, new indexes and one copy, never a table rebuild (D1
-- enforces foreign keys, so dropping `tasks` to rebuild it would cascade). Two
-- hand edits to what drizzle-kit wrote: its `__new_tasks` rebuild dropping the
-- column is deleted, and the copy is added. The meta snapshot is left as
-- drizzle-kit wrote it, without the column, to match cire/db/src/schema.ts.
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
CREATE INDEX `task_assignees_host_wedding_idx` ON `task_assignees` (`host_id`,`wedding_id`);--> statement-breakpoint
CREATE INDEX `task_assignees_wedding_task_idx` ON `task_assignees` (`wedding_id`,`task_id`,`assigned_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_wedding_unique` ON `tasks` (`id`,`wedding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wedding_hosts_id_wedding_unique` ON `wedding_hosts` (`id`,`wedding_id`);--> statement-breakpoint
INSERT INTO `task_assignees` (`task_id`, `host_id`, `wedding_id`, `assigned_at`)
SELECT `tasks`.`id`, `tasks`.`assigned_host_id`, `tasks`.`wedding_id`, unixepoch()
FROM `tasks`
INNER JOIN `wedding_hosts`
  ON `wedding_hosts`.`id` = `tasks`.`assigned_host_id`
  AND `wedding_hosts`.`wedding_id` = `tasks`.`wedding_id`;
