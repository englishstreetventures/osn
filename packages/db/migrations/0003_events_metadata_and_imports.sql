-- Extend `events` with calendar / dress-code / venue metadata.
-- D1 migrations are append-only; `slug`, `location`, `date` are kept for
-- backwards compatibility and will be retired in a later PR once consumers
-- have migrated to startAt / endAt / address.
ALTER TABLE `events` ADD `start_at` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `events` ADD `end_at` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `events` ADD `timezone` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `events` ADD `address` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `dress_code_description` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `dress_code_palette` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `pinterest_url` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `maps_url` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `sort_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Forward-looking spreadsheet stable-ID column. Nullable; current matching
-- remains `(family, firstName)` until the source sheet adds a Guest ID
-- column (see PR-C).
ALTER TABLE `guests` ADD `external_id` text;
--> statement-breakpoint

CREATE TABLE `imports` (
  `id` text PRIMARY KEY NOT NULL,
  `uploaded_at` integer NOT NULL,
  `format` text NOT NULL,
  `events_r2_key` text NOT NULL,
  `guests_r2_key` text NOT NULL,
  `summary` text NOT NULL,
  `status` text NOT NULL,
  `applied_at` integer,
  `reverted_at` integer
);
--> statement-breakpoint
CREATE INDEX `imports_status_uploaded_at_idx` ON `imports` (`status`, `uploaded_at`);
