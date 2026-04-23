---
title: Event Visibility Bug
description: Runbook for investigating event visibility issues — unauthorized access or incorrect access denial
tags: [runbook, events, security, incident]
severity: high
related:
  - "[[event-access]]"
  - "[[close-friends]]"
  - "[[pulse]]"
last-reviewed: 2026-04-23
---

# Event Visibility Bug Runbook

## Overview

Event visibility is one of Pulse's most security-sensitive features. Private events must only be visible to the organiser and users with RSVP rows. A visibility bug can either **leak private events** to unauthorized users or **incorrectly deny access** to authorized users.

## Symptoms

- Private event details visible to a user who should not have access
- Private event appearing in another user's event list
- Event details leaking through ICS export, communications endpoint, or RSVP endpoints
- 403 response instead of 404 (information disclosure -- reveals the event exists)
- Organiser unable to see their own event
- RSVP'd user getting 404 on an event they should see
- `invited` RSVP status list visible to non-organiser

## Diagnosis Steps

### 1. Identify the Leaking Endpoint

Check which route is exposing the data. All of these MUST use `loadVisibleEvent`:

- `GET /events/:id` -- event details
- `GET /events/:id/ics` -- iCal export
- `GET /events/:id/comms` -- communications
- `GET /events/:id/rsvps` -- RSVP list
- `GET /events/:id/rsvps/counts` -- RSVP counts
- `GET /events/:id/rsvps/latest` -- latest RSVPs

### 2. Check if the Route Uses `loadVisibleEvent`

Every direct-fetch route must call `loadVisibleEvent(eventId, viewerId)` from `pulse/api/src/services/eventAccess.ts`. If a route loads the event via `getEvent` instead of `loadVisibleEvent`, it bypasses the visibility check entirely (this is the S-H12 pattern).

**Where to look:** `pulse/api/src/routes/events.ts` and any new route files.

### 3. Check the Event's Visibility Field

Query the event to see its visibility setting:

```sql
SELECT id, visibility, organiser_id FROM events WHERE id = '<event-id>';
```

- `visibility = 'public'`: visible to everyone (including unauthenticated)
- `visibility = 'private'`: visible only to organiser + users with RSVP rows

### 4. Check RSVP Rows

For private events, check if the user has an RSVP entry:

```sql
SELECT * FROM rsvps WHERE event_id = '<event-id>' AND user_id = '<user-id>';
```

Valid RSVP statuses that grant visibility: `going`, `interested`, `not_going`, `invited`.

If the user has no RSVP row and is not the organiser, they should get 404.

### 5. Check Response Status Code

- Authorized viewers should get **200** with event data
- Unauthorized viewers should get **404** (not 403)
- Getting 403 instead of 404 is an information disclosure bug -- it reveals that the event exists

### 6. Check `listEvents` SQL Predicate Sync

The discovery endpoint (`listEvents`) uses a SQL `WHERE` clause to filter events by visibility. This SQL predicate must stay in sync with the JavaScript logic in `canViewEvent`.

**If they drift:**
- `listEvents` might show a private event that `canViewEvent` would reject (or vice versa)
- The SQL predicate is the source for list queries; `canViewEvent` / `loadVisibleEvent` is the source for direct-fetch queries

Check both:
- `pulse/api/src/services/events.ts` -- `listEvents` query
- `pulse/api/src/services/eventAccess.ts` -- `canViewEvent` and `loadVisibleEvent`

## Common Causes

| Cause | Severity | Resolution |
|-------|----------|------------|
| New route bypassing `loadVisibleEvent` (S-H12 pattern) | Critical | Replace `getEvent` with `loadVisibleEvent` in the route handler |
| SQL predicate out of sync with JS filter | High | Align the `WHERE` clause in `listEvents` with the logic in `canViewEvent` |
| Route returning 403 instead of 404 | Medium | Change to 404 -- never reveal private event existence |
| Missing RSVP status in visibility check | High | Ensure all valid RSVP statuses (`going`, `interested`, `not_going`, `invited`) grant access |
| Organiser check missing | High | Ensure `canViewEvent` checks `event.organiserId === viewerId` |
| Unauthenticated access to private event | Critical | Ensure the route requires auth before calling `loadVisibleEvent` for private events |
| Invited status list exposed to non-organiser | High | In `listRsvps`, return empty when `status: "invited"` and viewer is not the event organiser |

## Historical Findings

| Finding | Route | Issue | Status |
|---------|-------|-------|--------|
| S-H12 | `GET /events/:id` | No visibility gate | Fixed via `loadVisibleEvent` |
| S-H13 | `GET /events/:id/ics` | Leaked GEO coordinates | Fixed via `loadVisibleEvent` |
| S-H14 | `GET /events/:id/comms` | Leaked blast bodies | Fixed via `loadVisibleEvent` |
| S-H15 | `GET /events/:id/rsvps` | Invited list exposed | Fixed via `loadVisibleEvent` |
| S-H16 | `GET /events/:id/rsvps/counts` | Private event existence | Fixed via `loadVisibleEvent` |

All fixed via the shared `loadVisibleEvent` helper.

## Prevention

### For New Routes

When adding a new event-scoped route:

1. **Always** use `loadVisibleEvent(eventId, viewerId)` instead of `getEvent(eventId)`
2. Handle the `null` return (unauthorized) as **404**
3. Never return 403 for private events

### For Code Review

Check every PR that touches event routes:

- Does it add a new route under `/events/:id/*`?
- Does that route use `loadVisibleEvent`?
- Does it return 404 (not 403) for unauthorized access?

### Testing

Write tests for both authorized and unauthorized access:

```typescript
it("returns 404 for private event when not organiser and no RSVP", async () => {
  // Create private event as user A
  // Request as user B (no RSVP)
  // Assert 404
});

it("returns 200 for private event when user has RSVP", async () => {
  // Create private event as user A
  // Add RSVP for user B
  // Request as user B
  // Assert 200 with event data
});
```

## Related

- [[event-access]] -- the `loadVisibleEvent` and `canViewEvent` implementation
- [[close-friends]] -- close-friend visibility and RSVP ordering
- [[pulse]] -- Pulse events app overview
