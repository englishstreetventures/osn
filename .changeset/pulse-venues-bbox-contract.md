---
"@pulse/api": patch
---

Give the map surfaces a bounded, viewport-aware bbox contract.

`listAllVenues` was `db.select().from(venues)` — an unbounded scan feeding `GET /venues`. Both `GET /venues` and `GET /events` now accept an optional `(minLat, maxLat, minLng, maxLng)` viewport plus `limit`, validated at the route (all four corners or none; inverted or out-of-range boxes reject 400). Venues gets a hard server ceiling (100), applied as the default too so the no-bbox path is bounded without returning fewer pins than it did yesterday, and a deterministic `ORDER BY id` so the bounded page is the same one on every call, so the scan is bounded whatever the client sends; `listEvents` keeps its existing ceiling unchanged.

`GET /venues` now returns a new `VenuePin` model (`id, orgHandle, handle, name, kind, capacity, latitude, longitude`) instead of the full `Venue` shape, so the map list stays cheap. The existing `Venue` model and every other venue route are untouched.

Antimeridian-crossing boxes (`minLng > maxLng`) are out of scope and rejected the same as any other inverted box. A bbox query drops NULL-lat/lng rows (`gte`/`lte` never match NULL); the no-bbox path still returns them for venues.
