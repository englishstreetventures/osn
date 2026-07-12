-- Wedding profile + event locations (platform Phase 0, PR 1): organiser-provided
-- planning facts. Nothing here is guest-facing — these columns drive the
-- planning modules (pricing estimates, checklist lead-time seeding, per-event
-- vendor radius search), never the invite render.
--
-- Money is WEDDING-scoped, location is EVENT-scoped: a wedding can span
-- countries (a Sydney reception + Jaipur ceremonies is one wedding in two
-- places), so each event carries its own geocoded point + pricing region while
-- the wedding keeps one MAIN currency the organiser thinks in.
--
-- weddings:
--   wedding_date          date-only ISO string (YYYY-MM-DD); nullable — engaged
--                         couples often don't have one yet
--   guest_count_estimate  rough head count for estimates
--   currency              ISO 4217 code for every money figure on this wedding;
--                         NOT NULL DEFAULT so existing rows land on AUD
--   budget_total_minor    total budget in MINOR units (cents) of `currency`
-- events (free-text venue stays in the existing `address` column):
--   location_lat/lng      geocoded point for per-event vendor radius search;
--                         set by the key-optional server-side geocode of the
--                         address, or typed manually; both-or-neither enforced
--                         at the API boundary
--   pricing_region        key into the checked-in pricing dataset (closed enum
--                         validated at the API boundary — lib/pricing-regions.ts)
ALTER TABLE `weddings` ADD `wedding_date` text;--> statement-breakpoint
ALTER TABLE `weddings` ADD `guest_count_estimate` integer;--> statement-breakpoint
ALTER TABLE `weddings` ADD `currency` text NOT NULL DEFAULT 'AUD';--> statement-breakpoint
ALTER TABLE `weddings` ADD `budget_total_minor` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `location_lat` real;--> statement-breakpoint
ALTER TABLE `events` ADD `location_lng` real;--> statement-breakpoint
ALTER TABLE `events` ADD `pricing_region` text;
