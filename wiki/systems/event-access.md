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
  - "[[close-friends]]"
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
last-reviewed: 2026-04-24
---

# Event Access Control

## The Shared Visibility Gate

`pulse/api/src/services/eventAccess.ts` exports two functions that are the **single source of truth** for "can this viewer see this event?":

- `canViewEvent(event, viewerId)` -- returns a boolean
- `loadVisibleEvent(eventId, viewerId)` -- loads the event and applies the visibility check; returns the event or `null`

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

Every direct-fetch route that returns event data **MUST** use `loadVisibleEvent` instead of `getEvent`. Without the visibility gate, private events become bypassable by direct ID.

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

The SQL predicate was pushed into the `WHERE` clause (P-W12) to fix unstable page sizes -- previously the `LIMIT` was applied before the JS visibility filter, causing the client to receive fewer rows than requested.

## Security Finding History

These findings were all discovered in the full-event-view PR review and fixed via the shared `loadVisibleEvent` helper:

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

`listRsvps` has an additional gate beyond `loadVisibleEvent`: queries with `status: "invited"` return empty unless the viewer is the event organiser. Invitees never opted into being listed -- the public guest-list override applies only to people who have actually RSVPed.

## Friends Discovery — Graph-Symmetry Assumption

The `friendsOnly` discovery branch in `discoverEvents` interprets `pulse_users.attendance_visibility = "connections"` as "visible to people the *RSVPer* is connected to". Today this is equivalent to "people who claim the RSVPer as a connection" because the OSN social graph is **symmetric** (see `[[social-graph]]`). The predicate gates on the *viewer's* connection set without re-validating the friendship from the RSVPer's side.

If asymmetric follows / blocks ever land, this predicate must additionally verify `viewerId ∈ RSVPer.connections`, not only `RSVPer ∈ viewerId.connections`. Tracked as a forward-compatibility note (S-M2 from the discovery PR security review).

## Source Files

- [pulse/api/src/services/eventAccess.ts](../pulse/api/src/services/eventAccess.ts) -- `canViewEvent`, `loadVisibleEvent`, `buildVisibilityFilter`
- [pulse/api/src/services/events.ts](../pulse/api/src/services/events.ts) -- `listEvents` (consumes `buildVisibilityFilter`)
- [pulse/api/src/services/discovery.ts](../pulse/api/src/services/discovery.ts) -- `discoverEvents` (consumes `buildVisibilityFilter`)
- [pulse/api/src/routes/events.ts](../pulse/api/src/routes/events.ts) -- route-level usage
- [CLAUDE.md](../CLAUDE.md) -- "Shared visibility gate" section
