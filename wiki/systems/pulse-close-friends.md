---
title: Pulse Close Friends
aliases:
  - close friends (Pulse)
  - Pulse-scoped close friends
tags:
  - systems
  - social
  - pulse
  - privacy
status: current
related:
  - "[[social-graph]]"
  - "[[event-access]]"
  - "[[s2s-patterns]]"
  - "[[pulse]]"
packages:
  - "@pulse/db"
  - "@pulse/api"
  - "@pulse/app"
last-reviewed: 2026-04-26
---

# Pulse Close Friends

## Why this is Pulse-scoped, not OSN-scoped

OSN is a modular platform — apps opt in independently. Some OSN apps will not have a concept of close friends at all (e.g. a future read-only feed app), and apps that do may want different lists per app (your Pulse close friends and your hypothetical photo-sharing close friends are different audiences).

Close friends therefore lives **inside Pulse**. The OSN core social graph keeps only the universal primitives — connections and blocks. Each app that wants a "close friends"–style list owns its own table and CRUD, and validates membership eligibility against the OSN graph via the existing `graph:read` ARC scope.

## Data model

`pulse/db/src/schema/closeFriends.ts`:

```ts
pulseCloseFriends {
  id: text PRIMARY KEY               // "pcf_" prefix
  profileId: text NOT NULL           // OSN profile id of the list owner
  friendId: text NOT NULL            // OSN profile id of the friend
  createdAt: timestamp NOT NULL
  UNIQUE (profileId, friendId)
  INDEX profile_idx (profileId)
  INDEX friend_idx (friendId)
}
```

There are no foreign keys against the `users` table — these are cross-DB references. Eligibility is validated at the service layer (see below).

## What close friends does in Pulse

Close friends is a **personal signal**, not an audience for restricting event visibility. Two surfaces:

1. **Feed boost.** `events.listEvents` re-ranks results so that events whose organiser is in the viewer's close-friends list surface above other events. Stable partition: chronological order is preserved within each bucket.
2. **Hosting affordances.**
   - The RSVP avatar ring (`isCloseFriend: boolean`) on the event-detail page is driven by the local `pulse_close_friends` table — the row is set when an attendee has marked the *viewer* as a close friend (this is the original [[close-friends]] S-M27 directionality fix, preserved when we moved the table from OSN to Pulse).
   - The Pulse-app `Close friends` page (`/close-friends`) lets the user browse their connections and add/remove close friends.

There is **no** `guestListVisibility = "close_friends"` bucket. Close friends never gates access to events; it only re-ranks discovery and drives display signals.

## Service surface (`@pulse/api`)

`pulse/api/src/services/closeFriends.ts` — Effect Tag service:

| Function | Span | Notes |
|---|---|---|
| `addCloseFriend(profileId, friendId)` | `pulse.closeFriends.add` | Eligibility: `friendId !== profileId` AND `friendId ∈ graphBridge.getConnectionIds(profileId)`. Idempotent. |
| `removeCloseFriend(profileId, friendId)` | `pulse.closeFriends.remove` | Fails with `CloseFriendNotFound` when no row exists. |
| `listCloseFriendIds(profileId)` | `pulse.closeFriends.list` | Returns the friend IDs only — caller joins display metadata. |
| `isCloseFriendOf(profileId, friendId)` | `pulse.closeFriends.check` | Pure local lookup. |
| `getCloseFriendsOfBatch(viewerId, profileIds)` | `pulse.closeFriends.batch_of` | Reverse batched lookup, clamped to 1000. Used by `rsvps.listRsvps`. |
| `getCloseFriendIdsForViewer(viewerId)` | `pulse.closeFriends.ids_for_viewer` | Convenience `Set` wrapper for the feed-boost path. |

### Tagged errors

- `NotEligibleForCloseFriend` — `reason: "self" | "not_a_connection"`
- `CloseFriendNotFound`
- `DatabaseError` (tag: `"CloseFriendDatabaseError"` to distinguish from `events.DatabaseError` in the `rsvps` error union)

## HTTP routes

`pulse/api/src/routes/closeFriends.ts`, mounted under `/close-friends`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/close-friends` | Caller's list, joined with profile displays via the graph bridge. |
| `POST` | `/close-friends/:friendId` | Add. 201 ok / 422 self / 422 not_a_connection / 401. |
| `DELETE` | `/close-friends/:friendId` | Remove. 200 ok / 404. |
| `GET` | `/close-friends/:friendId/check` | Returns `{ isCloseFriend: boolean }`. |

## S2S / ARC

Adding a close friend validates that `friendId` is a current OSN connection of the caller. The check goes through `graphBridge.getConnectionIds`, which uses `scope: "graph:read"` (the existing scope — no new scope required).

The graph bridge no longer exposes `getCloseFriendIds` or `getCloseFriendsOf`; both close-friend bridge endpoints (`/graph/internal/close-friends` and `/graph/internal/close-friends-of`) were removed from `osn/api` since Pulse owns the data now.

## Observability

`pulse/api/src/metrics.ts` (all attributes are bounded literal-string unions):

- `pulse.close_friends.added` — counter, `result: "ok" | "duplicate" | "self" | "not_eligible" | "error"`
- `pulse.close_friends.removed` — counter, `result: "ok" | "not_found" | "error"`
- `pulse.close_friends.listed` — counter, `result_empty: "true" | "false"`
- `pulse.close_friends.list.size` — histogram, no attributes
- `pulse.close_friends.batch.size` — histogram, no attributes

## Source files

- `pulse/db/src/schema/closeFriends.ts` — schema
- `pulse/api/src/services/closeFriends.ts` — Effect service
- `pulse/api/src/routes/closeFriends.ts` — Elysia routes
- `pulse/api/src/services/rsvps.ts` — uses `getCloseFriendsOfBatch` to stamp `isCloseFriend`
- `pulse/api/src/services/events.ts` — uses `getCloseFriendIdsForViewer` for the feed boost in `listEvents`
- `pulse/app/src/pages/CloseFriendsPage.tsx` — UI
- `pulse/app/src/lib/closeFriends.ts` — client-side wrapper
