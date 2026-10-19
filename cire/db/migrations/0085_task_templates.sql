-- Checklist templates. A task seeded from a template names the template, the
-- item's stable key, the offset from the wedding date it was seeded with, and
-- whether its due date follows the wedding date ('template') or was set by
-- the couple ('manual', which every existing row reads). The unique index makes
-- applying a template twice add nothing. A deleted template task leaves a row in
-- task_template_dismissals so applying again does not bring it back unasked.
-- Additive: ALTER TABLE ADD and a new table, never a table rebuild.
CREATE TABLE `task_template_dismissals` (
	`wedding_id` text NOT NULL,
	`template_id` text NOT NULL,
	`template_item` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`wedding_id`, `template_id`, `template_item`),
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `template_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `template_item` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_offset_days` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_wedding_template_item_unique` ON `tasks` (`wedding_id`,`template_id`,`template_item`);