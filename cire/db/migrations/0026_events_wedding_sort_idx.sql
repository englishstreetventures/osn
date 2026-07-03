-- P-I2: `events_sort_order_idx` (migration 0004) went dead after wedding
-- scoping (migration 0006) — every events read is now either
-- `WHERE wedding_id = ? ORDER BY sort_order` (which used the single-column
-- `events_wedding_idx` and sorted in memory) or `WHERE id IN (...)` (PK
-- lookup, JS sort). Replace both single-column indices with one composite
-- `(wedding_id, sort_order)` index that serves the filter + order in a single
-- B-tree walk and drops a dead index's write cost on the import path. Mirrors
-- the `guests_family_id_sort_idx` pattern from migration 0004.
DROP INDEX IF EXISTS `events_sort_order_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `events_wedding_idx`;
--> statement-breakpoint
CREATE INDEX `events_wedding_id_sort_idx` ON `events` (`wedding_id`, `sort_order`);
