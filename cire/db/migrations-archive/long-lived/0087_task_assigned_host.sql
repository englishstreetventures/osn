-- Checklist assignee. A task can be assigned to one seat of its wedding
-- (`wedding_hosts.id`); NULL is a task nobody holds. A seat, not a profile id,
-- because the helper run sheet filters on the seat.
--
-- SET NULL, not cascade: removing a seat, or a co-host leaving, must keep the
-- task and leave it unassigned. The index is PARTIAL — it is the probe that
-- SET NULL runs on every seat delete, and most tasks are unassigned.
--
-- Additive: ALTER TABLE ADD, never a table rebuild. One hand edit to what
-- drizzle-kit wrote, so the migration matches the Drizzle schema and
-- cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`): `ON DELETE set null`,
-- which drizzle-kit leaves out of an ADD COLUMN.

ALTER TABLE `tasks` ADD `assigned_host_id` text REFERENCES wedding_hosts(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `tasks_assigned_host_idx` ON `tasks` (`assigned_host_id`) WHERE assigned_host_id IS NOT NULL;
