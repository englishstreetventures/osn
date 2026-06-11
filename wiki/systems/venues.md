---
title: Venues & Event Lineups
aliases:
  - venue pages
  - lineup timeline
tags:
  - systems
  - events
  - pulse
status: current
related:
  - "[[event-access]]"
  - "[[identity-model]]"
  - "[[pulse]]"
packages:
  - "@pulse/db"
  - "@pulse/api"
  - "@pulse/app"
last-reviewed: 2026-06-11
---

# Venues & Event Lineups

A venue is a physical place that hosts events — initially scoped to clubs, but the shape is generic. An event lineup is the programmed set of artist slots for one event ("DJ X plays 22:00–23:30"). Together they power the venue detail page (`/venues/:orgHandle/:venueHandle`) and the venue pin layer on the Explore map.

## Identity & addressing

Venues belong to an **OSN organisation** (see [[identity-model]]). The public URL is `/venues/:orgHandle/:venueHandle` — the org handle namespaces the venue handle, so two venues across the network can share a handle (or a name) without collision. Enforced by the unique index `venues_org_handle_idx (org_handle, handle)`.

The `id` column (`ven_*` prefix) is opaque: it is the FK target for `events.venue_id` and `event_lineup`, and is **never surfaced in URLs**.

## Schema (`@pulse/db`, migration `0005_venues_and_lineup`)

**`venues`** — `id`, `org_handle`, `handle`, `name`, `kind` (free-form, default `"club"`; bucketed at metric time), `description`, `address`/`city`/`country`, `latitude`/`longitude`, `capacity`, `hours`, `hero_image_url`, `website_url`, `instagram_handle`, `timezone` (IANA, default `"UTC"`), timestamps.

- `hours` is a JSON map keyed by ISO weekday `"1".."7"` (Mon=1), each value `{ open: "HH:MM", close: "HH:MM" }` in the venue's local time or `null` for closed. A null column means no fixed schedule (event-driven).
- Indexes: `venues_kind_idx`, `venues_lat_lng_idx` (bbox prefilter, same pattern as events), unique `venues_org_handle_idx`.

**`event_lineup`** — `id` (`lnp_*`), `event_id` FK, `artist_name` (b2b pairings stay one row/string — that's how lineups are billed), `role` enum (`headliner | support | resident | opener | guest` — bounded so the timeline can style headliners without parsing free text), `slot_start`/`slot_end` (absolute timestamps, so midnight-crossing sets order correctly), `order_index` (deterministic ordering for future simultaneous stages). Index `event_lineup_event_id_idx (event_id, slot_start)`.

**`events.venue_id`** — nullable FK; existing free-text `events.venue` remains for events without a structured venue.

## API surface (`@pulse/api`)

Routes nest under `/venues` (`createVenuesRoutes`, public — no viewer-scoped auth). The whole group is per-IP rate-limited (60 req/min, fail-closed, injectable backend — same posture as `/events/discover` S-L3; see [[rate-limiting]]):

| Route | Service | Notes |
|---|---|---|
| `GET /venues` | `listAllVenues` | Feeds the Explore map. Unbounded scan — tracked as P-W28 for a bbox-aware replacement. |
| `GET /venues/:orgHandle/:venueHandle` | `getVenue` | 404 via `VenueNotFound` tag. |
| `GET /venues/:orgHandle/:venueHandle/events` | `listVenueEvents` | `scope=upcoming|past|all` (default upcoming; past reads most-recent-first), `limit` validated 1–200 at the TypeBox boundary. **Public events only** (see [[event-access]]); rows pass through the `toPublicVenueEvent` allowlist serializer so organiser-internal fields (`chatId`, `commsChannels`, `createdByProfileId`, policies) never reach this anonymous surface — new columns are private-by-default. |
| `GET /venues/:orgHandle/:venueHandle/events/:eventId/lineup` | `listEventLineup` | Gated (S-H1): the event must pass `loadVisibleEvent(eventId, null)` (anonymous → public only) AND `event.venueId === venue.id`; otherwise 404 + `metricEventAccessDenied("lineup", …)`. |

Services are Effect-based with `pulse.venue.*` spans. Metrics (`pulse.venue.detail.requests/.duration`, `pulse.venue.events.listed`, `pulse.venue.lineup.listed`) use bounded attributes — `bucketVenueKind()` collapses free-text kinds to a closed union (`club | bar | warehouse | outdoor | theatre | other`) so crafted kind values can't inflate cardinality. `getVenue` records the detail metric only when called with `{ recordMetric: true }` (the detail route) — internal reuse by the programme/lineup paths stays out of the counter so it measures page views.

## Frontend (`@pulse/app`)

- **`VenueDetailPage`** (`/venues/:orgHandle/:venueHandle`): vertical mono-time lineup timeline (`VenueLineupTimeline`), snap-scroll event carousel (`VenueEventCarousel`), real-time open/closed badge computed in the venue's timezone (`computeOpenStatus` handles midnight-crossing windows), "Open in Maps" (`venueMapsUrl`), website + Instagram icon links. Fetches `scope=upcoming`; falls back to `scope=past&limit=1` only when no upcoming nights exist. `website_url` / `hero_image_url` render through `safeHttpUrl()` — non-http(s) schemes are dropped (S-M2).
- **Explore map venue layer**: diamond venue pins wrapped in `<A>` links. When a visible event pin sits at the same venue, the diamond is hidden and the event popover gains a "See venue →" CTA. Event pins are focusable `<button>`s — the popover opens on focus as well as hover (grace-timer dismiss, Escape closes), so the venue link stays keyboard-reachable (C-M2 / WCAG 2.1.1).
- Client fetchers in `pulse/app/src/lib/venues.ts` are fail-soft (null / `[]` on error) and `encodeURIComponent` every path segment.
- `Icon` was promoted from `explore/` to `components/` with `globe` + `instagram` glyphs added.

## Deferred / known follow-ups

- **P-W28** — replace `GET /venues` (and `listEvents`) with a shared bbox query contract `(minLat, maxLat, minLng, maxLng, limit)`; indexes already exist. See `wiki/TODO.md` Performance Backlog.
- Discovery routes linking *into* venue pages beyond the Explore map (search, event page → venue link) are intentionally deferred.
- Venue CRUD/admin is out of scope — rows are seed-only until organiser tooling lands. **Prerequisites for org self-service venue editing** (C-L1): DSA notice-and-action path (`POST /reports` coverage + `moderation_actions` rows) for venue descriptions/images, and server-side http(s) scheme validation on `website_url`/`hero_image_url` (the client already validates at render time — S-M2).
- Artist → profile linking would be a join table, not a restructure of `event_lineup`.
