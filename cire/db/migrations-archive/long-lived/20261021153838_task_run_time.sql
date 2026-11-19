-- A checklist task's time on the day (the run sheet). Five nullable columns,
-- written together by the task service, which holds the four states a task can
-- be in (untimed, fixed, linked, frozen); there is no CHECK. `event_id` links a
-- task to an event its time is counted from (`run_offset_minutes`, from the
-- event's start); `run_at` + `run_timezone` are a fixed time, or the last time
-- a linked task had when a schedule change removed its event
-- (`event_removed_at`).
--
-- SET NULL, not cascade: an event removed by a schedule change must keep its
-- tasks. The schedule change unlinks them itself, before the event delete, so
-- this is the backstop. Single-column on purpose: a composite (event_id,
-- wedding_id) key would null `wedding_id` too, which is NOT NULL, and every
-- event delete would fail. The index is PARTIAL — it is the probe that SET NULL
-- runs on every event delete, and most tasks are linked to nothing.
--
-- Additive: ALTER TABLE ADD, never a table rebuild, no back-fill. Every
-- existing task starts untimed.
ALTER TABLE `tasks` ADD `run_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `run_timezone` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `event_id` text REFERENCES events(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `run_offset_minutes` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `event_removed_at` integer;--> statement-breakpoint
CREATE INDEX `tasks_event_idx` ON `tasks` (`event_id`) WHERE event_id IS NOT NULL;
