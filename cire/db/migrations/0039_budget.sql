-- Phase 1 Budget v1 ([[platform-plan]] §4.2). A per-category wedding budget:
-- `budget_items` are line items filed under a service category (venue, catering,
-- …) carrying three OPTIONAL money figures (estimate → quoted → actual, all in
-- the wedding's single `currency`, minor units). `payments` are the schedule rows
-- (deposit/balance) that hang off an item with a due date and a paid stamp,
-- feeding the Overview upcoming-payments feed. All money is integer minor units;
-- no floats, no FX. v1 carries no vendor linkage; that's an additive Phase 2 FK.
--
-- Purely additive: two brand-new tables + two indexes. No rebuild, no data touched.
CREATE TABLE `budget_items` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  `name` text NOT NULL,
  `estimate_minor` integer,
  `quoted_minor` integer,
  `actual_minor` integer,
  `notes` text,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `budget_items_wedding_category_sort_idx` ON `budget_items` (`wedding_id`, `category`, `sort_order`);
--> statement-breakpoint
CREATE TABLE `payments` (
  `id` text PRIMARY KEY NOT NULL,
  `budget_item_id` text NOT NULL REFERENCES `budget_items`(`id`) ON DELETE CASCADE,
  `label` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `due_at` text,
  `paid_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payments_item_idx` ON `payments` (`budget_item_id`);
