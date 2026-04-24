---
title: Pulse
description: Pulse events app overview
tags: [app, events]
status: active
packages:
  - "@pulse/app"
  - "@pulse/api"
  - "@pulse/db"
port: 3001
last-reviewed: 2026-04-24
---

# Pulse

Pulse is OSN's event management app. Users create, discover, and RSVP to events with visibility controls driven by the OSN social graph.

## Architecture

```
@pulse/app (Tauri + SolidJS, iOS target ready)
  ├── SolidJS frontend (src/)
  ├── Rust + Tauri native layer (src-tauri/)
  └── Consumes @osn/client, @osn/ui, @pulse/api

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

Events move through statuses: `upcoming` → `ongoing` → `finished`. Events can also be `cancelled` at any point by the organiser.

Events created **without an explicit `endTime`** follow a tighter ladder so they don't linger as `ongoing` indefinitely:

1. At `MAYBE_FINISHED_AFTER_HOURS` (8h) past `startTime`, `deriveStatus` projects them as **`maybe_finished`** — a display-only status shown to guests as "maybe finished". This projection is **not persisted**; `applyTransition` skips the DB write for this transition, so no-endTime events still only produce one stored write over their lifetime.
2. At `AUTO_CLOSE_NO_END_TIME_HOURS` (12h) past `startTime`, the event auto-transitions to `finished` and the transition is persisted.
3. The organiser can manually `PATCH /events/:id { status: "finished" }` at any time to close the event early.

Events **with** an explicit `endTime` keep the original single-transition behaviour at `endTime`. A defence-in-depth cap of `MAX_EVENT_DURATION_HOURS` (48h) is enforced on both `POST /events` and `PATCH /events/:id` — excessive durations return 422 with `metricEventValidationFailure(op, "duration_exceeds_max")`.

### RSVP System

Users can RSVP to events with one of four statuses:

- **going** -- confirmed attendance
- **interested** -- tentative
- **not_going** -- declined
- **invited** -- added by organiser, not yet responded

RSVP visibility is filtered through the social graph. The system supports counts, latest RSVPs, and attendee lists with close-friend indicators.

### Visibility Filtering

Events can be **public** or **private**:

- **Public events**: visible to everyone, including unauthenticated users
- **Private events**: visible only to the organiser or users with an RSVP row

Non-authorised viewers get `null` from `loadVisibleEvent` and the route returns **404** (not 403, to avoid disclosing existence). See [[event-access]] for the full visibility gate.

Every direct-fetch route (`GET /events/:id`, `/ics`, `/comms`, `/rsvps`, `/rsvps/counts`, `/rsvps/latest`) MUST use `loadVisibleEvent`. Discovery (`listEvents`) uses an equivalent SQL predicate that must stay in sync.

### iCal Export

Events can be exported in iCal format for calendar integration.

### Communications

Event organisers can send communications to attendees.

### Event Chat (Placeholder)

Event group chats are planned via the Zap messaging backend. Users will not need a Zap install to participate in event group chats -- the messaging backend is a shared service.

## Cross-Service Integration

### Graph Bridge

All calls from Pulse to OSN identity / graph data go through a single file: `pulse/api/src/services/graphBridge.ts`. This is the only call surface that reaches `@osn/api` from Pulse — every cross-boundary read is HTTP + [[arc-tokens|ARC token]].

Exports:

```typescript
getConnectionIds(userId)                      // accepted connections set
getCloseFriendIds(userId)                     // outbound close-friends set
getCloseFriendsOf(viewerId, attendeeIds[])    // attendees who marked viewer as CF
getUserDisplays(userIds[])                    // batched user metadata join
OsnDbLayer                                     // Effect Layer for routes
```

Benefits:

- One file owns auth, URL construction, and retry logic for every cross-boundary call
- `grep 'OSN_API_URL\|graphBridge' pulse/api/src` shows every cross-boundary call site
- Bridge maps OSN errors onto `GraphBridgeError` so callers catch one tag

See [[s2s-patterns]] for the full cross-service architecture.

### Close Friends UI

Close-friend indicators use shared UI tokens from `pulse/app/src/lib/ui.ts`:

```typescript
CLOSE_FRIEND_RING_CLASS  // green outline on avatars
avatarClasses(base, isCloseFriend)  // helper
```

The `RsvpAvatar` component reads the constant, and both `RsvpSection` and `RsvpModal` use `RsvpAvatar`. See [[close-friends]] for details.

## Platform Limits

Limits are defined in `pulse/api/src/lib/limits.ts`. Schemas, route bodies, and documentation reference the named constant -- never inline the number.

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
- [[close-friends]] -- close-friend indicators and graph queries
- [[s2s-patterns]] -- cross-service communication architecture
- [[platform-limits]] -- MAX_EVENT_GUESTS and future caps
