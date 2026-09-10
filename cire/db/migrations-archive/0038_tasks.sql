-- Phase 1 Checklist / Tasks ([[platform-plan]] §4.1). A freeform per-wedding
-- task list: the organiser adds tasks and files each under a lead-time bucket
-- (12 months out → day-of). `due_at` is an OPTIONAL date, independent of the
-- bucket — a task can sit in a bucket with or without a specific due date. v1 is
-- freeform (no seeded template) and carries no category/assignee/vendor linkage;
-- those are additive later and don't reshape this table.
--
-- Purely additive: a brand-new table + one index. No rebuild, no data touched.
CREATE TABLE `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `notes` text,
  `timeframe_bucket` text NOT NULL,
  `due_at` text,
  `status` text DEFAULT 'open' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `tasks_wedding_bucket_sort_idx` ON `tasks` (`wedding_id`, `timeframe_bucket`, `sort_order`);
