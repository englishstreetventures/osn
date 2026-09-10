-- Data-layer review (2026-07-30): `events` was the one entity table with no
-- timestamps at all — odd for the table at the centre of the change-history
-- feature, and it left "when did this event last change?" unanswerable when
-- debugging an import/editor reconcile. NULLABLE (not NOT NULL DEFAULT 0):
-- legacy rows' creation time is genuinely unknown, and a fake 1970 epoch would
-- masquerade as data. The importer stamps both on create and bumps
-- `updated_at` on every update; the event-image endpoints bump it on
-- image/crop writes.
ALTER TABLE `events` ADD `created_at` integer;
--> statement-breakpoint
ALTER TABLE `events` ADD `updated_at` integer;
