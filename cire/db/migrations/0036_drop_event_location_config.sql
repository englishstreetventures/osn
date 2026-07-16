-- Remove the separate event "location config" subsystem (product-owner
-- decision, 2026-07-16). The free-text `events.address` already advises the
-- venue and is the SOLE location source the guest site renders (the Google
-- Maps embed in cire/web is built from `address` alone — no lat/lng, no
-- geocoding, no map API key). The three columns dropped here — `location_lat`,
-- `location_lng`, `pricing_region` (added by 0030) — only ever fed UNBUILT
-- Phase 3 planning features (per-event vendor-radius search, per-region pricing
-- estimates). They were never guest-facing. If Phase 3 ever needs coordinates
-- it will geocode `address` on-demand then (YAGNI) — this retires the redundant
-- stored copy + all its geocode/pricing-region machinery.
--
-- ⚠️ DESTRUCTIVE: this permanently deletes any data in these columns on prod
-- D1. Confirm the columns are empty (or the data is expendable) before applying
-- in production — the maintainer authorises the apply.
--
-- MECHANISM — plain `ALTER TABLE … DROP COLUMN`, NOT the FK-preserving
-- `__keep_*` table rebuild (0006/0032/0033). SQLite (and D1) reject DROP COLUMN
-- only when the column participates in an index, PRIMARY KEY, FOREIGN KEY,
-- UNIQUE, CHECK, or generated column. NONE of the three do: the sole index on
-- `events` is `events_wedding_id_sort_idx` on `(wedding_id, sort_order)`; the
-- FKs into `events` (`guest_events.event_id`, `rsvps.event_id`) reference
-- `events.id`; and there are no CHECK/UNIQUE/generated columns over these three.
-- So a plain drop is safe and cheap — it preserves every other events column,
-- the sort index, and the guest_events/rsvps FKs untouched. (Verified against a
-- replica of the events shape before authoring.)
ALTER TABLE `events` DROP COLUMN `location_lat`;--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `location_lng`;--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `pricing_region`;
