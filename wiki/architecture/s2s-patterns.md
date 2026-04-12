---
title: Cross-Package S2S Patterns
aliases:
  - service-to-service
  - graphBridge
  - S2S
  - cross-domain access
tags:
  - architecture
  - s2s
  - integration
status: current
related:
  - "[[arc-tokens]]"
  - "[[social-graph]]"
  - "[[platform-limits]]"
packages:
  - "@pulse/api"
  - "@osn/core"
  - "@osn/db"
last-reviewed: 2026-04-12
---

# Cross-Package S2S Patterns

When a Pulse service needs identity or graph data (RSVP visibility, user displays, close-friends lookups), **every call must go through `pulse/api/src/services/graphBridge.ts`**. That file is the single import surface for `@osn/core` + `@osn/db` inside Pulse.

## Why a Bridge?

Three reasons for the indirection:

1. **Migration path.** The eventual S2S migration from direct package import to [[arc-tokens|ARC-token]] HTTP is a single-file change. Today Pulse imports `createGraphService()` directly (zero network overhead). When scaling to multi-process, the bridge swaps to HTTP calls with ARC tokens -- and no other file in Pulse changes.

2. **Auditable surface.** A reviewer can `grep '@osn/core' pulse/api/src` and see every cross-boundary call in one place.

3. **Error mapping.** The bridge maps OSN errors onto a single `GraphBridgeError` tagged error so callers catch one tag instead of a union of errors they don't own.

## Exports

```typescript
getConnectionIds(userId)                      // accepted connections set
getCloseFriendIds(userId)                     // outbound close-friends set
getCloseFriendsOf(viewerId, attendeeIds[])    // attendees who marked viewer as CF
getUserDisplays(userIds[])                    // batched user metadata join
OsnDbLayer                                     // Effect Layer for routes
```

## Bounded Sets

Graph membership sets are bounded by `MAX_EVENT_GUESTS` (see [[platform-limits]]) -- the bridge is not paginated and never returns partial sets for the visibility filter. This cap was raised from 100 to 1000 after S-M28/P-W13 revealed the original cap silently truncated membership sets, causing the visibility filter to under-permit users with larger graphs.

## Current vs Future S2S Strategy

| Phase | Strategy | Overhead |
|-------|----------|----------|
| **Current** | Pulse API imports `createGraphService()` from `@osn/core` directly | Zero -- in-process function call |
| **Multi-process** | HTTP calls to `/graph/internal/*` with ARC token auth | Network round-trip + token overhead |
| **Third-party** | External apps call OSN endpoints with ARC tokens | Full S2S auth + rate limiting |

The deferred decision on S2S scaling is tracked in TODO.md. The migration trigger is horizontal scaling (multi-process or multi-machine deployment).

## Adding a New Cross-Domain Call

1. Add the function to `graphBridge.ts` -- import the relevant service from `@osn/core`
2. Wrap the call in a try/catch that maps errors to `GraphBridgeError`
3. Export the function from the bridge
4. Consume it in the Pulse service that needs the data
5. Never import `@osn/core` or `@osn/db` directly from any other Pulse file

## Source Files

- [pulse/api/src/services/graphBridge.ts](../pulse/api/src/services/graphBridge.ts) -- the bridge module
- [osn/core/src/services/graph.ts](../osn/core/src/services/graph.ts) -- graph service (consumed by bridge)
- [CLAUDE.md](../CLAUDE.md) -- "Cross-package S2S patterns" section
