---
title: Social Graph
aliases:
  - connections
  - graph service
  - relationships
tags:
  - systems
  - social
  - identity
status: current
related:
  - "[[close-friends]]"
  - "[[s2s-patterns]]"
  - "[[osn-core]]"
  - "[[event-access]]"
packages:
  - "@osn/core"
  - "@osn/db"
last-reviewed: 2026-04-13
---

# Social Graph

The social graph is OSN's core relationship system. It manages connections between users, close-friend designations, and blocks. All graph logic lives in `@osn/core` with the schema in `@osn/db`.

## Relationship Types

### Connections (bidirectional)

A connection is a mutual relationship between two users. It requires both parties to agree.

**Flow:** request -> accept/decline/cancel

- Either user can send a connection request
- The recipient can accept or decline
- The sender can cancel a pending request
- Either party can remove an accepted connection

### Close Friends (unidirectional)

A close-friend marking is a one-way graph edge. A marks B as a close friend; B may not reciprocate and may not even know. See [[close-friends]] for the full implications and security history.

### Blocks (unidirectional)

A block is a one-way action. When A blocks B:
- All existing connections and close-friend markings between A and B are removed (wrapped in a DB transaction after P-W17)
- B cannot send connection requests to A
- Blocks are currently global across all OSN apps (per-app blocking is a deferred decision)

The `is-blocked` route only checks whether the caller has blocked the target (`isBlocked(caller, target)`) -- it does not reveal whether the target has blocked the caller (S-M15).

## Architecture

```
osn/core/src/services/graph.ts     # Graph service (Effect-based)
osn/core/src/routes/graph.ts       # Graph routes (Elysia)
osn/db/src/schema.ts               # connections, close_friends, blocks tables
```

The graph service exports functions like:
- `sendConnectionRequest`, `acceptConnection`, `declineConnection`, `cancelConnection`, `removeConnection`
- `addCloseFriend`, `removeCloseFriend`, `isCloseFriendOf`, `getCloseFriendsOfBatch`
- `blockProfile`, `unblockProfile`, `isBlocked`, `eitherBlocked`
- `getConnections`, `getPendingRequests`, `getBlocks`

## Test Coverage

209 tests covering services and routes. Test areas include:
- Connection lifecycle (request, accept, decline, cancel, remove)
- Close-friend CRUD and batch lookups
- Block behavior (mutual cleanup, directional checks)
- Rate limiting on graph write endpoints
- Error handling (not found, already exists, self-referential operations)
- Input validation (handle regex, length bounds via TypeBox `HandleParam`)

## Rate Limiting

All graph write endpoints are rate-limited at 60 requests per user per minute (S-M16). The rate limiter is injected via DI -- graph routes accept injected rate limiter instances, which was part of the [[redis]] migration Phase 1 abstraction work.

## Cross-Package Access

Other packages (notably `@pulse/api`) access the social graph through `graphBridge.ts` -- see [[s2s-patterns]] for the full pattern. The bridge exports:

- `getConnectionIds(userId)` -- accepted connections set
- `getCloseFriendIds(userId)` -- outbound close-friends set
- `getCloseFriendsOf(viewerId, attendeeIds[])` -- attendees who marked viewer as close friend
- `getUserDisplays(userIds[])` -- batched user metadata join

## Error Handling

Graph routes use `safeError()` to ensure only `GraphError` and `NotFoundError` messages are exposed to clients (S-M17). Raw DB/Effect errors are never surfaced. Error objects logged via `Effect.logError` go through `safeErrorSummary()` which extracts only `_tag` + `message` (S-L9).

## Input Validation

The `:handle` route parameter uses TypeBox `HandleParam` with regex + length bounds (S-M18). This prevents injection and ensures handles conform to the reservation rules.

## Performance Notes

- N+1 queries in graph list functions replaced with `inArray` batch fetches (P-W6)
- `eitherBlocked` collapsed from two sequential `isBlocked` calls to a single OR query (P-W7)
- `blockProfile` replaced SELECT-then-DELETE with direct `DELETE WHERE OR` (P-W8)
- Missing index on `close_friends.friend_id` added as `close_friends_friend_idx` (P-W16)
- `removeConnection` and `blockProfile` wrapped in DB transactions (P-W17)

## Source Files

- [osn/core/src/services/graph.ts](../osn/core/src/services/graph.ts) -- graph service
- [osn/core/src/routes/graph.ts](../osn/core/src/routes/graph.ts) -- graph routes
- [osn/db/src/schema.ts](../osn/db/src/schema.ts) -- schema (connections, close_friends, blocks)
- [osn/core/tests/services/graph.test.ts](../osn/core/tests/services/graph.test.ts) -- service tests
- [osn/core/tests/routes/graph.test.ts](../osn/core/tests/routes/graph.test.ts) -- route tests
