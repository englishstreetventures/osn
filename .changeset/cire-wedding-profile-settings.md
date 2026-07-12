---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
---

Wedding profile + per-event locations (platform Phase 0, PR 1): organisers
record the planning facts — date, expected guests, main currency, total
budget, and where each event happens — that the upcoming planning modules
(checklist lead times, pricing estimates, vendor radius search) build on.
Nothing here is guest-facing.

**Money is wedding-scoped, location is event-scoped**: a wedding can span
countries (a Sydney reception + Jaipur ceremonies is one wedding in two
places), so each event carries its own geocoded point + pricing region while
the wedding keeps one MAIN currency the couple thinks in.

- `@cire/db`: migration `0030_wedding_profile.sql` adds `wedding_date`,
  `guest_count_estimate`, `currency` (`NOT NULL DEFAULT 'AUD'`), and
  `budget_total_minor` (integer minor units) to `weddings`, plus
  `location_lat`/`location_lng` and `pricing_region` to `events` (the venue
  free-text stays in the existing `events.address`). All nullable /
  defaulted — additive + self-backfilling, mirrored across the three DDL
  surfaces under the T-S1 lockstep test.
- `@cire/api`: `GET /api/organiser/weddings/:weddingId/settings` (owner or
  co-host) + `PUT …/settings` (owner-only; PATCH semantics — omitted fields
  keep their value, explicit `null` clears; the slug is deliberately
  read-only — renaming would free the old slug for takeover while printed
  invite links still point at it). `PUT …/events/:eventId/location`
  (member-level, like the import
  that writes the schedule; lat/lng both-or-neither enforced at the schema
  boundary, tenant-scoped 404 for another wedding's event). `POST
  …/settings/geocode` (member-level, per-IP rate-limited): **key-optional +
  fail-soft** — with no `GOOGLE_GEOCODING_API_KEY` secret (or on any upstream
  failure) it answers `unavailable`, the editor degrades to manual lat/lng
  entry, and nothing is sent to Google. `pricing_region` is a closed,
  state-granular enum in `lib/pricing-regions.ts` (single source of truth for
  the Phase 3 pricing dataset), derived server-side from the geocoded
  state/country. New metrics `cire.wedding.settings.saved`,
  `cire.event.location.saved`, `cire.geocode.requests`.
- `@cire/organiser`: a "Settings" tab on each wedding's dashboard — name,
  invite link (shown read-only), date, guest count, main currency, and
  budget; co-hosts see it read-only, and a saved rename updates the header +
  wedding list without a refetch. A per-event location
  editor on the Events tab (`EventLocationsPanel`) — server-side "Look up"
  from each event's sheet address (or manual coordinates when geocoding is
  off) + a region select, member-editable, writing through the shared events
  cache. The events cache gains `ensureEventsLoaded` so the two Events-tab
  panels share one fetch.
