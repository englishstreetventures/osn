-- Performance indices surfaced by the PR-A review.
-- `events.sort_order` is read-ordered on every claim response.
CREATE INDEX `events_sort_order_idx` ON `events` (`sort_order`);
--> statement-breakpoint
-- Composite index covering the (family filter, sort) access pattern used by
-- claim.lookup and getAllGuests. Replaces the single-column family_id index.
DROP INDEX IF EXISTS `guests_family_id_idx`;
--> statement-breakpoint
CREATE INDEX `guests_family_id_sort_idx` ON `guests` (`family_id`, `sort_order`);
