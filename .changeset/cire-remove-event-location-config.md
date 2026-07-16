---
"@cire/api": patch
"@cire/db": patch
"@cire/organiser": patch
---

Remove the separate event "location config" subsystem — the free-text event `address` is the sole location source.

The stored coordinates + pricing region on `events` (`location_lat`, `location_lng`, `pricing_region`, added by migration 0030) were a redundant, separate config whose only consumers were unbuilt Phase 3 planning features (per-event vendor-radius search, per-region pricing estimates). Nothing guest-facing read them: the Google Maps embed is built from `address` alone (no lat/lng, no geocoding, no map API key). If Phase 3 ever needs coordinates it will geocode `address` on-demand then (YAGNI).

Removed: the three columns (migration `0036_drop_event_location_config.sql`, a plain `ALTER TABLE … DROP COLUMN` — no index/FK/UNIQUE/CHECK on them), the `event-location` write route + service, the `settings/geocode` route + Google geocoder + the `GOOGLE_GEOCODING_API_KEY` binding, the `pricing-regions` derivation lib, the `EventLocationBody`/`GeocodeBody` schemas, the event-location + geocode metrics, and the organiser `EventLocationsPanel` (unmounted from the schedule tab).

Payload change: the guest + organiser event payloads (the organiser events read, the events-store `EventRow`) no longer carry `locationLat` / `locationLng` / `pricingRegion`. The wedding `GET /settings` response drops `geocodingAvailable`.
