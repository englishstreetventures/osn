---
title: Close Friends
aliases:
  - close friendship
  - close-friend ring
  - CF
tags:
  - systems
  - social
  - privacy
  - security
status: current
related:
  - "[[social-graph]]"
  - "[[event-access]]"
  - "[[frontend-patterns]]"
  - "[[platform-limits]]"
finding-ids:
  - S-M27
  - S-L8
  - P-I4
  - P-W16
packages:
  - "@osn/api"
  - "@pulse/api"
  - "@pulse/app"
last-reviewed: 2026-04-23
---

# Close Friends

## Core Concept

Close friendship is a **one-way graph edge**. When A marks B as a close friend, it means:

- A considers B a close friend
- B may not know, may not reciprocate, and has no say in the matter
- This is purely A's classification of B in A's own social graph

This unidirectional nature has **critical security implications** for any feature that uses close-friend status as an access gate.

## S-M27: The Inverted Visibility Bug

The `close_friends` per-row attendance visibility filter in `pulse/api/src/services/rsvps.ts` had **inverted directionality**: it checked the *viewer's* close-friends list instead of the *attendee's* close-friends list. This meant:

- A stalker who unilaterally added a target as a close friend could see the target's gated RSVPs
- The target had no control over who could see their attendance
- The one-way edge was being used as a two-way access gate

**Fix:** The `close_friends` visibility bucket was removed entirely. Close-friendship is a one-way graph edge and makes a poor access gate in either direction:

- Checking the viewer's list: stalker can add target and gain access (the bug)
- Checking the attendee's list: attendee marking viewer as close friend = granting visibility, but viewer never opted into being "visible to close friends of others"

## Current Behavior

### Attendance Visibility

Attendance visibility options are now:
- **`connections`** -- visible to mutual connections
- **`no_one`** -- hidden from everyone

There is no `close_friends` bucket. The close-friends feature is a display signal, not an access gate.

### Display Signal

Close-friend attendees are surfaced first in the RSVP list as a display signal. When viewing an event's guest list:

1. Attendees who have marked the viewer as a close friend appear first
2. They receive a visual treatment (green ring) to indicate the relationship
3. This is a convenience feature, not a privacy gate

### UI Treatment

The green ring is implemented via shared UI tokens in `pulse/app/src/lib/ui.ts`:

```typescript
CLOSE_FRIEND_RING_CLASS  // green outline applied to close-friend avatars
avatarClasses(base, isCloseFriend)  // helper that conditionally appends the ring class
```

See [[frontend-patterns]] for the full UI token system.

## Graph Helpers

The following helpers exist in `@osn/api` for close-friend operations:

- `addCloseFriend(userId, friendId)` -- create a one-way close-friend edge
- `removeCloseFriend(userId, friendId)` -- remove the edge
- `isCloseFriendOf(userId, friendId)` -- check if userId has marked friendId as close friend
- `getCloseFriendsOfBatch(viewerId, userIds[])` -- from a list of userIds, return those who have marked viewerId as a close friend

### Batch Size Limits

`getCloseFriendsOfBatch` is clamped to `MAX_BATCH_SIZE` (1000) to prevent unbounded query parameters:

- **S-L8** found the function accepted unbounded `userIds` arrays
- **P-I4** confirmed no upper bound on the array size
- Both fixed by clamping to 1000

### Performance

- Missing index on `close_friends.friend_id` caused table scans in `getCloseFriendsOfBatch` and `removeConnection` cleanup -- fixed with `close_friends_friend_idx` (P-W16)
- `isCloseFriendOf` used `SELECT *` with `.limit(1)` for existence check -- fixed to project only the PK (P-I3)

## How Pulse Accesses Close-Friend Data

Pulse accesses close-friend data through the graph bridge (see [[s2s-patterns]]):

```typescript
// In pulse/api/src/services/graphBridge.ts
getCloseFriendsOf(viewerId, attendeeIds[])  // attendees who marked viewer as CF
```

This was originally a raw SQL query in the Pulse codebase; it was migrated to use the `getCloseFriendsOfBatch` service helper from `@osn/api` once that helper was added.

## Security Finding History

| ID | Status | Description |
|----|--------|-------------|
| S-M27 | Fixed | Inverted visibility filter -- stalker could see gated RSVPs by adding target as close friend |
| S-L8 | Fixed | `getCloseFriendsOfBatch` accepted unbounded `userIds` array -- clamped to 1000 |
| P-I4 | Fixed | Same root cause as S-L8 -- no upper bound on batch size |
| P-W16 | Fixed | Missing index on `close_friends.friend_id` -- added `close_friends_friend_idx` |

## Source Files

- [osn/api/src/services/graph.ts](../../osn/api/src/services/graph.ts) -- close-friend service functions
- [osn/db/src/schema.ts](../../osn/db/src/schema.ts) -- `close_friends` table
- [pulse/api/src/services/graphBridge.ts](../../pulse/api/src/services/graphBridge.ts) -- bridge to graph service
- [pulse/api/src/services/rsvps.ts](../../pulse/api/src/services/rsvps.ts) -- RSVP visibility filtering
- [pulse/app/src/lib/ui.ts](../../pulse/app/src/lib/ui.ts) -- `CLOSE_FRIEND_RING_CLASS` token
