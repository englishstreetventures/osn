---
title: Platform Limits
aliases:
  - limits
  - MAX_EVENT_GUESTS
  - caps
tags:
  - systems
  - configuration
  - pulse
status: current
related:
  - "[[s2s-patterns]]"
  - "[[pulse-close-friends]]"
  - "[[pulse]]"
packages:
  - "@pulse/api"
last-reviewed: 2026-04-26
---

# Platform Limits

Platform-wide caps live in a single `limits.ts` file per workspace. Schemas, route bodies, and documentation reference the named constant -- never inline the number.

## Current Limits

| Constant | Value | Where it bites |
|----------|-------|----------------|
| `MAX_EVENT_GUESTS` | 1000 | Bulk-invite batch size; graph membership set in `graphBridge.ts`; Pulse `getCloseFriendsOfBatch` clamp |

## MAX_EVENT_GUESTS

The 1000 guest cap is the hard ceiling for event attendance across the Pulse platform. It affects:

- **Bulk invite:** the maximum number of users that can be invited to a single event
- **Graph bridge:** `getConnectionIds` in [[s2s-patterns|graphBridge.ts]] caps its result set at this value (raised from 100 after S-M28/P-W13)
- **Batch lookups:** Pulse's `getCloseFriendsOfBatch` (in [[pulse-close-friends]]) is clamped to 1000 which aligns with this limit

## Beyond 1000 Guests

Events with more than 1000 guests belong to a future **verified-organisation tier** (Pulse phase 2). This tier would include:

- Organisation accounts with elevated caps
- Per-event support flow that bumps the cap
- Dashboards, SLA, bulk import/export
- Paid ticketing

**Do not bump this number without a team discussion.** The limit exists because the graph membership sets used for visibility filtering are not paginated -- the bridge returns complete sets. Raising the cap requires validating that the full set still fits comfortably in memory and that the visibility filter's performance remains acceptable.

## Adding a New Limit

1. Add the constant to `pulse/api/src/lib/limits.ts` (or the equivalent `limits.ts` in the relevant workspace)
2. Reference it by name in schemas, route bodies, and service logic -- never inline the number
3. Document it in this page with a row in the table above
4. Note downstream consumers that need to stay in sync with the limit

## Source Files

- [pulse/api/src/lib/limits.ts](../../pulse/api/src/lib/limits.ts) -- limits constants
- [pulse/api/src/services/graphBridge.ts](../../pulse/api/src/services/graphBridge.ts) -- consumes MAX_EVENT_GUESTS
- [CLAUDE.md](../../CLAUDE.md) — "Platform limits" section
