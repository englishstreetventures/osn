---
title: Event Access Control
aliases:
  - event visibility
  - loadVisibleEvent
  - canViewEvent
  - visibility gate
tags:
  - systems
  - security
  - access-control
  - pulse
status: current
related:
  - "[[social-graph]]"
  - "[[pulse-close-friends]]"
  - "[[pulse]]"
  - "[[event-visibility-bug]]"
finding-ids:
  - S-H12
  - S-H13
  - S-H14
  - S-H15
  - S-H16
packages:
  - "@pulse/api"
last-reviewed: 2026-07-22
---

# Event Access Control

## The Shared Visibility Gate

`pulse/api/src/services/eventAccess.ts` exports three functions that are the **single source of truth** for "can this viewer see this event?":

- `canViewEvent(event, viewerId)` -- returns a boolean. Accepts any object with `{ id, visibility, createdByProfileId }` so callers can pass a trimmed projection (see below).
- `loadVisibleEvent(eventId, viewerId)` -- loads the full event row and applies the visibility check; returns the event or `null`. Used by every direct-fetch route that needs the event body.
- `checkEventVisibility(eventId, viewerId)` -- lightweight variant for metric-only endpoints. Selects only the three columns the gate consults (`id`, `visibility`, `createdByProfileId`) and returns `{ createdByProfileId }` on success or `null` on miss/hidden. Used by `POST /events/:id/share` and `POST /events/:id/exposure` so the high-frequency share-attribution pings don't read the full event row on every call. Public events short-circuit before the `event_rsvps` lookup.

## Rules

### Public events
Visible to everyone, including unauthenticated users.

### Private events
Visible only to:
- The **organiser** (the user who created the event)
- Any user with an **RSVP row** (status: `going`, `interested`, `not_going`, or `invited`)

### Non-authorised viewers
Get `null` from `loadVisibleEvent`. The route returns **404** (not 403) to avoid disclosing the existence of private events.

## Mandatory Usage

Every direct-fetch route that returns event data **MUST** use `loadVisibleEvent` instead of `getEvent`. Without the visibility gate, anyone who knows the ID can read a private event.

Routes that must use the gate:
- `GET /events/:id` -- event detail
- `GET /events/:id/ics` -- iCal export
- `GET /events/:id/comms` -- communications/blasts
- `GET /events/:id/rsvps` -- guest list
- `GET /events/:id/rsvps/counts` -- RSVP counts
- `GET /events/:id/rsvps/latest` -- latest RSVPs

When adding a new event-scoped route, **always** load the event via `loadVisibleEvent` instead of `getEvent`.

## Discovery vs Direct Fetch

- **List / discovery** (`listEvents`, `discoverEvents`) consume the shared `buildVisibilityFilter(viewerId)` helper exported from `services/eventAccess.ts`. This is a SQL predicate mirror of `canViewEvent`, applied in the `WHERE` clause so post-LIMIT page sizes stay stable.
- **Direct fetch** uses `loadVisibleEvent` which loads the event first, then checks visibility in JS.

`buildVisibilityFilter` and `canViewEvent` must stay byte-for-byte equivalent. The predicate is:

- Public events → visible to everyone.
- Private events → visible to `createdByProfileId = viewerId` **or** `EXISTS (SELECT 1 FROM event_rsvps WHERE event_id = events.id AND profile_id = viewerId)`.

Any code that SELECTs from `events` and returns multiple rows MUST consume `buildVisibilityFilter` — divergence re-opens the S-H12..S-H16 regression class. Do not reinvent the filter.

P-W12 moved the SQL predicate into the `WHERE` clause to fix unstable page sizes. Before that, the `LIMIT` ran before the JS visibility filter, so the client got fewer rows than it asked for.

## Security Finding History

The full-event-view PR review found all of these. The shared `loadVisibleEvent` helper fixed them:

| ID | Status | Description |
|----|--------|-------------|
| S-H12 | Fixed | `GET /events/:id` did not gate by `visibility` -- leaked private event details to anyone with the URL |
| S-H13 | Fixed | `GET /events/:id/ics` leaked private event metadata including GEO coordinates as a downloadable file |
| S-H14 | Fixed | `GET /events/:id/comms` leaked organiser blast bodies (venue codes, addresses, dress codes) |
| S-H15 | Fixed | `GET /events/:id/rsvps?status=invited` leaked the organiser's invite list to any viewer |
| S-H16 | Fixed | `GET /events/:id/rsvps/counts` leaked existence + activity of private events |

### Key Design Decision: 404 vs 403

Non-authorised viewers receive 404, not 403. Returning 403 would confirm that the event exists, which is itself a privacy leak for private events. The 404 response is byte-identical whether the event doesn't exist or the viewer is not authorised.

### RSVP-specific Gate (S-H15)

`listRsvps` has an additional gate beyond `loadVisibleEvent`: queries with `status: "invited"` return empty unless the viewer is the event organiser. Invitees never opted into being listed -- the public guest-list override applies only to people who RSVPed.

## Attendee Visibility — `canViewAttendees` (W4)

**Seeing that an event exists** (`canViewEvent`) and **enumerating its attendees** are distinct concerns. An invited guest can open a private event, but the organiser may not want the full guest list exposed to every attendee.

`canViewAttendees(event, viewerId)` is a pure, synchronous policy in `services/eventAccess.ts` that captures the second concern. It is **organiser-only** today (`viewerId === event.createdByProfileId`) — the creator is the one party guaranteed to be allowed to enumerate guests. It needs no DB round trip and accepts a trimmed `{ createdByProfileId }` projection.

The `GET /events/:id/rsvps` and `/events/:id/rsvps/latest` responses carry it as an **additive, non-breaking** `canViewAttendees` boolean. The decision (locked in W4) is *additive flag now, organiser-only payload cutover deferred*: existing clients keep rendering the `rsvps` array unchanged while the UI migrates to consult the flag. When the cutover lands, the row payload itself becomes organiser-only and `canViewAttendees` gates it.

## Friends Discovery — Graph-Symmetry Assumption

The `friendsOnly` discovery branch in `discoverEvents` interprets `pulse_users.attendance_visibility = "connections"` as "visible to people the *RSVPer* is connected to". Today this means the same as "people who claim the RSVPer as a connection", because the OSN social graph is **symmetric** (see `[[social-graph]]`). The predicate gates on the *viewer's* connection set without re-validating the friendship from the RSVPer's side.

If asymmetric follows / blocks ever land, this predicate must also verify `viewerId ∈ RSVPer.connections`, not only `RSVPer ∈ viewerId.connections`. Tracked as a forward-compatibility note (S-M2 from the discovery PR security review).

## Share-Source Attribution

When the same gate runs on the share-attribution surface (`POST /events/:id/share`, `POST /events/:id/exposure`), the wire input includes a `source: ShareSource` field. `ShareSource` is the closed enum `instagram | facebook | tiktok | x | whatsapp | copy_link | other` and is the single source of truth for three layers:

- HTTP boundary: `shareSourceTypeBox` (TypeBox literal union) in `pulse/api/src/lib/shareSource.ts`
- Service decode: `ShareSourceSchema` (Effect Schema literal) in the same file
- Metric attribute type: `import type { ShareSource } from "./lib/shareSource"` in `pulse/api/src/metrics.ts`

All three layers must agree on the wire shape. To add a destination (e.g. Zap, future OSN-native share targets), widen the array constant and the matching frontend mirror in `pulse/app/src/lib/shareSource.ts`.

### Attribution rules

`upsertRsvp` writes two attribution columns on `event_rsvps`:

- `share_source_first` is **sticky**: set once on the first sourced RSVP and never overwritten. Mirrors first-touch UTM attribution — the discovery channel.
- `share_source_last` is **overwriting**: updated every time the user re-enters via a sourced link. Most-recent-touch view for the organiser.

The organiser's own self-RSVP drops `shareSource` server-side so a preview of a self-shared link doesn't pollute the organiser's analytics. The exposure endpoint applies the same exclusion when `claims.profileId === event.createdByProfileId`.

### Metrics

Four bounded-cardinality counters drive the per-platform funnel. Attributes are limited to the closed `ShareSource` enum × the closed `ShareSurface` enum (`event_detail` today):

- `pulse.events.share.invoked { source, surface }` -- outbound share clicks
- `pulse.events.share.exposure { source, surface }` -- inbound sourced page-loads (excludes organiser self-views)
- `pulse.rsvps.attribution.first { source }` -- ticks once per RSVP when `share_source_first` lands
- `pulse.rsvps.attribution.last { source }` -- ticks every time `share_source_last` changes

### Rate limits

Both endpoints are unauthenticated. Per-IP fail-closed limiters make the metric counters costly to poison: 60/min on `/share`, 120/min on `/exposure` (higher because real page reloads of a sourced URL hit this surface). See `[[rate-limiting]]` and the deferred `S-L2 (share-attribution)` follow-up on `getClientIp`'s `"unknown"` bucket.

## Source Files

- [pulse/api/src/services/eventAccess.ts](../pulse/api/src/services/eventAccess.ts) -- `canViewEvent`, `loadVisibleEvent`, `checkEventVisibility`, `canViewAttendees`, `buildVisibilityFilter`
- [pulse/api/src/lib/shareSource.ts](../pulse/api/src/lib/shareSource.ts) -- `SHARE_SOURCES`, `ShareSourceSchema`, `shareSourceTypeBox`
- [pulse/api/src/services/rsvps.ts](../pulse/api/src/services/rsvps.ts) -- `upsertRsvp` attribution writes + organiser self-RSVP exclusion
- [pulse/api/src/services/events.ts](../pulse/api/src/services/events.ts) -- `listEvents` (consumes `buildVisibilityFilter`)
- [pulse/api/src/services/discovery.ts](../pulse/api/src/services/discovery.ts) -- `discoverEvents` (consumes `buildVisibilityFilter`)
- [pulse/api/src/routes/events.ts](../pulse/api/src/routes/events.ts) -- route-level usage including `/:id/share` + `/:id/exposure`
- [CLAUDE.md](../CLAUDE.md) -- "Shared visibility gate" section
