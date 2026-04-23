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
  - "@osn/api"
  - "@shared/crypto"
last-reviewed: 2026-04-23
security-fixes:
  - S-H100
  - S-H101
  - S-M100
  - S-M101
  - S-M102
  - S-L101
---

# Cross-Package S2S Patterns

When a Pulse service needs identity or graph data (RSVP visibility, user displays, close-friends lookups), **every call must go through `pulse/api/src/services/graphBridge.ts`**. That file is the single seam for all S2S calls from Pulse to `@osn/api`.

## Why a Bridge?

Three reasons for the indirection:

1. **Auditable surface.** A reviewer can `grep 'osn/api' pulse/api/src` and see every cross-boundary call in one place.

2. **Error mapping.** The bridge maps all HTTP/network failures onto a single `GraphBridgeError` tagged error so callers catch one tag instead of a union they don't own.

3. **Transport isolation.** Auth, URL construction, and retry logic are local to this file — no other Pulse file knows about ARC tokens or endpoint paths.

## Current Architecture

`@pulse/api` calls `@osn/api`'s `/graph/internal/*` HTTP endpoints, authenticated with [[arc-tokens|ARC tokens]]. There is no direct package import of OSN code from Pulse.

```
pulse/api --[ARC token HTTP]--> osn/api /graph/internal/*
                                     |
                                     +--> /connections
                                     +--> /close-friends
                                     +--> /close-friends-of
                                     +--> /profile-displays
                                     +--> /register-service  (bootstrap only)
```

## Exports

```typescript
getConnectionIds(profileId)                    // accepted connections set
getCloseFriendIds(profileId)                   // outbound close-friends set
getCloseFriendsOf(viewerId, attendeeIds[])     // attendees who marked viewer as CF
getProfileDisplays(profileIds[])               // batched profile metadata join
startKeyRotation()                             // startup: register key + schedule auto-rotation
```

## Bounded Sets

Graph membership sets are bounded by `MAX_EVENT_GUESTS` (see [[platform-limits]]) — the bridge is not paginated and never returns partial sets for the visibility filter.

## S2S Strategy

| Phase | Strategy | Overhead |
|-------|----------|----------|
| **Current** | HTTP calls to `osn/api /graph/internal/*` with ARC token auth | Network round-trip + token overhead |
| **Third-party** | External apps call OSN endpoints with ARC tokens | Full S2S auth + rate limiting |

## ARC Key Management

`pulse/api` uses **ephemeral key + auto-rotation** exclusively:

1. On startup, `startKeyRotation()` generates a fresh P-256 key pair and registers the public key via `POST /graph/internal/register-service` (authenticated with `INTERNAL_SERVICE_SECRET`). Throws at startup if `INTERNAL_SERVICE_SECRET` is unset.
2. Rotation fires `KEY_ROTATION_BUFFER_HOURS` (default 2h) before expiry. New key is registered BEFORE the signing singleton is swapped — zero downtime.
3. On rotation failure, retries after 5 min with ±30 s jitter to prevent thundering-herd across horizontal instances.

No private key in any file. No manual key management needed.

See [[arc-tokens]] for the full ARC token system, `kid`-based key lookup, and `service_account_keys` schema.

## Performance Notes

- `getCloseFriendsOf` and `getConnectionIds` are issued in parallel (`Effect.all` with `concurrency: "unbounded"`) when both are needed in `filterByAttendeePrivacy`.
- `getProfileDisplays` is always issued after fetching RSVP rows (depends on the profile IDs in those rows).
- Short-circuits to `Effect.succeed(new Set/Map())` when the input array is empty — no HTTP call.

## Adding a New Cross-Domain Call

1. Add the function to `graphBridge.ts` — use `osGet<T>` or `osPost<T>`
2. Wrap in `Effect.tryPromise` catching to `GraphBridgeError`
3. Export the function
4. Consume in the Pulse service that needs the data
5. Never import `@osn/api` or `@osn/db` directly from any other Pulse file (the bridge is the only seam)

## Source Files

- [pulse/api/src/services/graphBridge.ts](../../pulse/api/src/services/graphBridge.ts) — the bridge module
- [osn/api/src/routes/graph-internal.ts](../../osn/api/src/routes/graph-internal.ts) — internal graph routes (`/register-service` + graph reads)
- [CLAUDE.md](../../CLAUDE.md) — "Cross-package S2S patterns" section
