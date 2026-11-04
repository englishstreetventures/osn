---
title: Pulse
description: Pulse events app overview
tags: [app, events]
status: active
packages:
  - "@pulse/web"
  - "@pulse/api"
  - "@pulse/db"
dev-host: https://pulse.localhost
related:
  - "[[pulse-landing]]"
  - "[[pulse-close-friends]]"
  - "[[pulse-onboarding]]"
  - "[[venues]]"
  - "[[event-access]]"
  - "[[devloop-urls]]"
last-reviewed: 2026-11-04
---

# Pulse

Pulse is OSN's event management app. Users create, discover, and RSVP to events with visibility controls driven by the OSN social graph.

## Architecture

```
@pulse/web (SolidStart, client-rendered)
  ├── SolidJS frontend (src/)
  └── Consumes @osn/client, @shared/ui, @pulse/api

@pulse/api (Elysia + Eden, binary, port 3001)
  ├── Events CRUD + lifecycle
  ├── RSVP system with visibility filtering
  ├── iCal export
  ├── Communications
  ├── Eden treaty client (@pulse/api/client)
  ├── graphBridge → @osn/api (HTTP + ARC)
  └── @pulse/db (Drizzle + SQLite)
```

### `@pulse/api` and `@osn/api`

`@pulse/api` runs its own Elysia process on port 3001 and exposes `@pulse/api/client` (an Eden treaty wrapper) for the Pulse frontend. It imports `@pulse/db` and reaches OSN identity / graph data only through the bridge in `services/graphBridge.ts` (HTTP + ARC → `@osn/api` on port 4000). See [[s2s-patterns]].

## Key Features

### Event CRUD

Full event lifecycle management:

- Create events with title, description, start/end time, location, visibility
- Update events (organiser only)
- Delete events (organiser only)
- List events with filtering (default filters out past events)

### Lifecycle Transitions

Events move through statuses: `upcoming` → `ongoing` → `finished`. Events can also be `cancelled`.

`cancelled` and `finished` are terminal for automatic transitions: `applyTransition` writes a derived status only `WHERE status NOT IN ('cancelled', 'finished')`, so a read that loaded the row before a cancel cannot overwrite it.

A cancelled event records who cancelled it in `cancellationReason`, with `cancelledAt` beside it:

| Reason | Written by | Organiser can undo |
|---|---|---|
| `organiser` | `PATCH /events/:id { status: "cancelled" }`, `createEvent` with that status, or `cancelSeries` for every future instance | Yes, unless the event has a `hardDeleteAt` |
| `host_left` | `requestErasure` when the host leaves Pulse; `cancelErasure` restores it | No |

`PATCH /events/:id` refuses (422, `metricEventValidationFailure("update", "system_cancelled")`) any change to an event that is `host_left` or has a `hardDeleteAt`, and refuses `status: "maybe_finished"` (`status_not_settable`). Setting any other status clears `cancelledAt` and `cancellationReason`.

`updateSeries` refuses a cancelled series (422), including one cancelled after the request read it: the template write matches only an open series, and its result is what the request returns. The instance write skips every instance that is cancelled, `host_left` or has a `hardDeleteAt`, as well as those the organiser edited on their own. A `this_and_following` edit takes its cutoff from the `from` instance only when that instance belongs to the series; any other `from` is refused (422) before anything is written.

When the host leaves, one UPDATE cancels their events that are neither finished nor cancelled (`host_left`) and gives them, and every one the host had already cancelled, the same 14-day `hardDeleteAt`. `cancelErasure` clears `hardDeleteAt` from every hosted event that has one, whatever its status, since that is the column the sweeper deletes by. A series cancel takes over a future `host_left` instance (reason becomes `organiser`, `cancelledAt` and `hardDeleteAt` kept), so cancelling the erasure leaves it cancelled.

Transitions are derived when an event is read and written back by `applyTransition` (one event) or `applyTransitions` (a list page, one `UPDATE` per from → to pair). Each write applies only while the row is neither `cancelled` nor `finished`, so a cancel or early close committed between the read and the write is left as it is.

Events created **without an explicit `endTime`** follow a tighter ladder so they do not stay `ongoing` for ever:

1. At `MAYBE_FINISHED_AFTER_HOURS` (8h) past `startTime`, `deriveStatus` projects them as **`maybe_finished`** — a display-only status shown to guests as "maybe finished". This projection is **not persisted**; `applyTransition` skips the DB write for this transition, so no-endTime events still only produce one stored write over their lifetime.
2. At `AUTO_CLOSE_NO_END_TIME_HOURS` (12h) past `startTime`, the event auto-transitions to `finished` and the transition is persisted.
3. The organiser can manually `PATCH /events/:id { status: "finished" }` at any time to close the event early.

Events **with** an explicit `endTime` keep the original single-transition behaviour at `endTime`. Both `POST /events` and `PATCH /events/:id` enforce a defence-in-depth cap of `MAX_EVENT_DURATION_HOURS` (48h) — a longer duration returns 422 with `metricEventValidationFailure(op, "duration_exceeds_max")`.

### RSVP System

Users can RSVP to events with one of four statuses:

- **going** -- confirmed attendance
- **maybe** -- tentative (refused when the event sets `allowInterested: false`)
- **not_going** -- declined
- **invited** -- added by organiser, not yet responded

RSVPs close when the event is `cancelled`: `upsertRsvp` refuses a new reply or a change (422), and the event page shows no RSVP buttons. Replies given before the cancel are kept, so an event the organiser un-cancels still has its guest list. On a guest-list event the invite check runs first, so a caller with no invite gets `403 Invitation required` whatever the event's state. An invite is an RSVP row too: `POST /events/:id/invite` is refused (422) on a cancelled event or one with a `hardDeleteAt`.

Two concurrent replies for the same person are safe: a first RSVP that loses the race to insert becomes an update of the winner's row, and first-touch attribution (`shareSourceFirst`) is decided against the row at write time.

The social graph filters RSVP visibility. The system serves counts, latest RSVPs, and attendee lists with close-friend indicators.

### Visibility Filtering

Events can be **public** or **private**:

- **Public events**: visible to everyone, including unauthenticated users
- **Private events**: visible only to the organiser or users with an RSVP row

Non-authorised viewers get `null` from `loadVisibleEvent` and the route returns **404** (not 403, to avoid disclosing existence). See [[event-access]] for the full visibility gate.

Every direct-fetch route (`GET /events/:id`, `/ics`, `/comms`, `/rsvps`, `/rsvps/counts`, `/rsvps/latest`) MUST use `loadVisibleEvent`. List / discovery surfaces (`listEvents`, `discoverEvents`) use the shared `buildVisibilityFilter` helper from `services/eventVisibility.ts` — the single source of truth for the SQL predicate equivalent to `canViewEvent`. (`services/eventAccess.ts` re-exports it, so either import path reaches the same function.)

### Discovery

`GET /events/discover` is the unified "What's on" feed. Powers the Explore page default view; filter chips and the More filters drawer translate into query params:

- **`category`** — first-class filter, indexed (`events_category_idx`).
- **`from` / `to`** — startTime window. Default `from = now` so past events never surface.
- **`lat` / `lng` / `radiusKm`** — bbox range-scan (`events_lat_lng_idx`) plus a JS haversine pass to convert the bounding square into a circle. Max 500 km.
- **`priceMin` / `priceMax` / `currency`** — price in minor units under the given currency. Events in other currencies drop out. `priceMax=0` keeps null-priced rows (`null` ≡ free); `priceMin > 0` excludes them.
- **`friendsOnly=true`** — union of events hosted by a connection OR RSVPed by a connection. RSVPs are restricted to **positive engagement only** (`going`, `interested`); `invited` (organiser-only pre-RSVP marker) and `not_going` (explicit decline) never surface. The RSVP branch LEFT-JOINs `pulse_users` and respects `attendance_visibility = 'no_one'` (the viewer's own RSVP is excluded — it isn't a *friend* signal). When the viewer has zero connections, the predicate uses a sentinel ID so the SQL still runs and timing matches the populated case.

Per-IP rate limited (60 req/min, `PULSE_IP_LIMITS.discovery`), in memory: each process or Worker isolate counts on its own. Visibility predicate consumed via `buildVisibilityFilter` in `services/eventVisibility.ts` — single source of truth shared with `listEvents`.

Pagination is cursor-based on `(startTime, id)` — stable under concurrent inserts, same shape on web + mobile. Finished / cancelled events are excluded.

Response shape includes a `series: Record<seriesId, { id, title }>` map so event cards can render a "Part of …" banner above each card without inlining the title on every row — the banner links through to the event detail page, where the series link lives.

Observability: `pulse.discovery.search` span wraps the whole query with a nested `pulse.discovery.friends_lookup` around the graph call. Metrics in `pulse/api/src/metrics.ts`: `pulse.discovery.searched` counter (scope / friends_only / has_location_filter / has_price_filter / result_empty), `pulse.discovery.search.duration` histogram, and `pulse.discovery.filters.applied` counter per engaged dimension (`category | datetime | location | friends | price`). All attributes are bounded string-literal unions; no userId / eventId on metrics.

### iCal Export

Events export in iCal format for calendar apps.

### Pricing

Events can optionally carry a price. Two columns on `events`:

- `price_amount` — `integer`, nullable. Stored in **minor units** (cents/pence/yen) so `$18.50 = 1850`. Never a float.
- `price_currency` — `text`, nullable. ISO 4217 code from a curated allowlist: `USD, EUR, GBP, CAD, AUD, JPY`.

Invariant: both columns set, or both null. Enforced in the Effect Schema `priceInvariant` filter in `pulse/api/src/services/events.ts` — the HTTP boundary also validates via TypeBox, but the service-layer filter is the authoritative check.

Display rule: `price_amount` null **or** `0` → render `"Free"`. Otherwise format via `Intl.NumberFormat` using the stored currency. The `formatPrice` helper in `pulse/web/src/lib/formatPrice.ts` caches formatters so long feeds don't pay per-render allocation.

Max price: `99999.99` in major units (= `9_999_999` minor for 2dp currencies; = `99999` for JPY after the cap-before-conversion check). Over that → HTTP 422.

Currency allowlist and caps live in `pulse/api/src/lib/currency.ts` — see `SUPPORTED_CURRENCIES`, `MAX_PRICE_MAJOR`, and `toMinorUnits` / `fromMinorUnits`.

### Venues & Lineups

Org-scoped venue pages (`/venues/:orgHandle/:venueHandle`) with a lineup timeline, event carousel, timezone-aware open/closed badge, and a clickable venue pin layer on the Explore map. Backed by the `venues` + `event_lineup` tables and the public `/venues` route group. See [[venues]] for the full contract.

### Communications

Event organisers can send communications to attendees.

### Event Chat (Placeholder)

Event group chats are planned on the Zap messaging backend. Users will not need a Zap install to join event group chats -- the messaging backend is a shared service.

## Cross-Service Integration

### Graph Bridge

All calls from Pulse to OSN identity / graph data go through a single file: `pulse/api/src/services/graphBridge.ts`. This is the only call surface that reaches `@osn/api` from Pulse — every cross-boundary read is HTTP + [[arc-tokens|ARC token]].

Exports:

```typescript
getConnectionIds(profileId)                   // accepted connections set
getProfileDisplays(profileIds[])              // batched profile metadata join
OsnDbLayer                                    // Effect Layer for routes
```

Close-friend lookups are no longer routed through the bridge — they live in the Pulse-local table (see [[pulse-close-friends]]).

Benefits:

- One file owns auth, URL construction, and retry logic for every cross-boundary call
- `grep 'OSN_API_URL\|graphBridge' pulse/api/src` shows every cross-boundary call site
- Bridge maps OSN errors onto `GraphBridgeError` so callers catch one tag

See [[s2s-patterns]] for the full cross-service architecture.

### Close Friends UI

Close-friend indicators use shared UI tokens from `pulse/web/src/lib/ui.ts`:

```typescript
CLOSE_FRIEND_RING_CLASS  // green outline on avatars
avatarClasses(base, isCloseFriend)  // helper
```

The `RsvpAvatar` component reads the constant, and both `RsvpSection` and `RsvpModal` use `RsvpAvatar`. See [[pulse-close-friends]] for the full close-friends contract.

## Platform Limits

`pulse/api/src/lib/limits.ts` defines the limits. Schemas, route bodies, and documentation reference the named constant -- never inline the number.

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_EVENT_GUESTS` | 1000 | Bulk-invite batch size; graph membership sets in graphBridge.ts |

Beyond 1000 guests, events belong to a future verified-organisation tier (Pulse phase 2). Do not bump this number without a team discussion. See [[platform-limits]] for more.

## Testing

```bash
bun run --cwd pulse/api test:run   # Run Pulse API tests once
bun run --cwd pulse/db test:run    # Run Pulse DB tests once
bun run --cwd pulse/api test       # Watch mode
```

Route tests use `createEventsRoutes(createTestLayer())` in `beforeEach` for full isolation.

## Related

- [[event-access]] -- visibility gate and access control
- [[venues]] -- org-scoped venues, event lineups, venue detail page
- [[pulse-close-friends]] -- Pulse-scoped close-friends list
- [[s2s-patterns]] -- cross-service communication architecture
- [[platform-limits]] -- MAX_EVENT_GUESTS and future caps
