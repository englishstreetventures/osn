-- Per-head budget lines: a price per guest and, optionally, the events whose
-- guests the line counts.
--
-- `unit_price_minor` non-null marks a per-head line. Its estimate is that price
-- times the guests at its events, worked out from the RSVPs on every read, so
-- nothing derived is stored here. `per_head_event_ids` is a JSON array of event
-- ids, NULL meaning every event; see the comment on `budgetItems` in
-- cire/db/src/schema.ts for why it is a column rather than a join table.
--
-- Both columns are nullable with no default, so every existing line reads as a
-- fixed line, exactly as before.

ALTER TABLE `budget_items` ADD `unit_price_minor` integer;--> statement-breakpoint
ALTER TABLE `budget_items` ADD `per_head_event_ids` text;