---
"@pulse/api": minor
"@pulse/app": minor
"@pulse/db": patch
---

Event discovery — unified "What's on" feed.

**Feature**

- New `GET /events/discover` route: filters on category, time window, bbox + haversine radius, price range (with currency), and friends-only. Cursor pagination on `(startTime, id)` with infinite scroll on both web + mobile. Per-IP rate limit (60 req/min) — same posture as the OSN graph routes.
- Friends filter is the union of events hosted by a connection and events RSVPed to by a connection. The RSVP branch LEFT-JOINs `pulse_users` and respects `attendance_visibility = "no_one"` (a user who hid their RSVPs never surfaces events via the friends signal; the viewer's own RSVP is excluded). Restricted to `going` / `interested` — `invited` (organiser-only marker) and `not_going` (explicit decline) are excluded.
- Series-aware: discovery returns individual event occurrences only; the response includes a `series: Record<seriesId, { id, title }>` map so the Explore card can render a "Part of …" banner that links through to the event detail page.
- Visibility predicate extracted into a shared `buildVisibilityFilter` helper (`services/eventVisibility.ts`). `listEvents` and `discoverEvents` both consume it — one source of truth keeps the S-H12..S-H16 regression class closed. As a side-effect, `listEvents` now also returns private events the viewer has an RSVP row on (was previously owner-only).

**Schema**

- New indexes: `(visibility, start_time)` (replaces single-column `events_visibility_idx`), `category`, and `(latitude, longitude)` to support discovery seeks + bbox prefilter. Plus `event_rsvps (profile_id, event_id)` so the visibility EXISTS lookup keys on the constant `viewerId` first (the existing `(event_id, profile_id)` index has the wrong leading column for that shape).

**App**

- Explore page is now the unified discovery view (`from = now` default), with a `DiscoveryFilters` drawer for time/radius/price/friends. Existing chip rail translates into query params (e.g. "Tonight" → `to = endOfDay`, "Free" → `priceMax = 0`).
- Geolocation: explicit "Use my location" button in the drawer. Coords are resolved once on consent and stored in the filter signal — never on every refetch. Inline explainer makes the requirement clear; if the user enters a radius without consent the filter is silently dropped.

**Observability**

- `pulse.discovery.search` span + nested `pulse.discovery.friends_lookup`. New metrics in `pulse/api/src/metrics.ts` — `pulse.discovery.searched` (counter, bounded attrs), `pulse.discovery.search.duration` (histogram, seconds), `pulse.discovery.filters.applied` (counter per engaged dimension).

**Follow-ups** tracked in TODO.md: Pulse interest profile onboarding (unblocks the "interests" dimension), per-user preferred currency on `pulse_users`, server-side free-text search, and the AI prompt filter after extended scrolling. Forward-compatibility note in `wiki/systems/event-access.md` calls out the assumption that the social graph stays symmetric — if asymmetric follows / blocks land, the friends predicate must additionally verify `viewerId ∈ RSVPer.connections`.
