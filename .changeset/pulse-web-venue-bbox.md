---
"@pulse/web": patch
---

The Explore map now asks the server for the venues in its box.

`GET /venues` takes a viewport and returns a slim eight-field pin, so
`fetchAllVenues` is replaced by `fetchVenuePins(bounds)`, which sends
`minLat`/`maxLat`/`minLng`/`maxLng`. The client-side bbox filter in
`ExploreMap` is gone with it — what stays is dropping a venue that already
has an event pin at the same spot, which the server knows nothing about.

Also ends a type lie: `fetchAllVenues` cast the response to `VenueSummary[]`,
an 18-field row, while nine of those fields had stopped arriving. The new
`VenuePin` interface matches what the endpoint actually returns. `VenueSummary`
is untouched — the venue detail endpoint still returns the full row.

`BBOX` moves to an export on `ExploreMap` so the map's projection and the
venue query read one literal box.
