# @pulse/db

## 0.8.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @shared/db-utils@0.2.2

## 0.8.0

### Minor Changes

- 7349512: Add Zap messaging backend with chat and message services for event chat integration

  - Create `@zap/db` package with chats, chat_members, and messages schema (Drizzle + SQLite)
  - Create `@zap/api` package with Elysia server (port 3002), chat/message REST routes, Effect services, and observability metrics
  - Add `chatId` column to Pulse events schema for event-chat linking
  - Add `zapBridge` service in Pulse for provisioning event chats and managing membership

## 0.7.0

### Minor Changes

- ebaf56a: Event attendance visibility is `connections | no_one`. Close-friendship
  is a one-way graph edge, so using it as an access gate would leak your
  attendance to anyone you'd marked as a close friend regardless of
  whether they reciprocated. Close-friends are a display signal only:
  friendly attendees are surfaced first in `listRsvps` (via the
  `isCloseFriend` row flag) and get the green ring affordance in
  `RsvpAvatar`.

  - `pulse_users.attendance_visibility` enum is `"connections" | "no_one"`.
  - `filterByAttendeePrivacy` gates on the two buckets above.
  - `listRsvps` fetches up to 200 rows, sorts close-friend rows to the top
    (stable sort preserves createdAt DESC within each bucket), then
    slices to the caller's requested limit — so even the 5-row inline
    strip reliably surfaces close friends when any exist.

## 0.6.0

### Minor Changes

- e82d793: Add full event view: shareable `/events/:id` route with map preview, find-directions, RSVP section + modal (going / maybe / not going / invited), add-to-calendar (ICS), comms summary, and a Zap-bound chat placeholder.

  New event configuration: `visibility` (public/private — controls discovery), `guestListVisibility` (public/connections/private), `joinPolicy` (open/guest_list), `allowInterested` (toggles "Maybe"), and `commsChannels` (sms/email). Each option in the create flow has an info popover.

  New API surface on `@pulse/api`:

  - `GET /events/:id/rsvps` / `/rsvps/latest` / `/rsvps/counts` — server-side visibility filtering using OSN's social graph (connections + close friends), with per-attendee privacy honoured (`attendanceVisibility` in `pulse_users`). Public-guest-list events override per-row privacy.
  - `POST /events/:id/rsvps` (upsert own RSVP, enforces `joinPolicy` and `allowInterested`)
  - `POST /events/:id/invite` (organiser-only, bulk invite)
  - `GET /events/:id/ics` (RFC 5545 calendar export)
  - `GET /events/:id/comms` and `POST /events/:id/comms/blasts` (organiser-only blast log; SMS/email send is stubbed pending real providers)
  - `PATCH /me/settings` (Pulse-side `attendanceVisibility`: `connections` | `close_friends` | `no_one`)

  New `@pulse/db` tables: `pulse_users` (Pulse-side user settings, keyed by OSN user id) and `event_comms` (append-only blast log). `events` gains `visibility`, `guestListVisibility`, `joinPolicy`, `allowInterested`, `commsChannels`. `event_rsvps` gains `"invited"` status and `invitedByUserId`.

  `listEvents` now hides `visibility = "private"` events from non-owners — a behaviour change for the discovery feed.

  `@pulse/api` now imports `@osn/core` + `@osn/db` directly (the first cross-package consumer of OSN's social graph). The bridge is isolated in `services/graphBridge.ts` so the eventual ARC-token HTTP migration is local to that file.

  **Platform limit:** events can hold up to **1000 guests** (`MAX_EVENT_GUESTS` in `pulse/api/src/lib/limits.ts`). The cap also bounds the bulk-invite endpoint and the visibility-filter graph membership sets. Beyond 1000, events belong to a future verified-organisation tier with bespoke infrastructure — see `pulse/api/README.md`.

  **Post-review hardening (S-H12 through S-H16, S-M27/S-M28/S-M29, S-L20/S-L21, P-C1, P-W12/W13/W14):**

  - All direct event-fetch routes (`GET /events/:id`, `/ics`, `/comms`, `/rsvps[/counts/latest]`) now share a `loadVisibleEvent` gate so private events are only visible to the organiser or to invited / RSVP'd users (404 to anyone else). Closes the discovery / direct-fetch desync.
  - `GET /events/:id/rsvps?status=invited` is now organiser-only — invitee lists are not exposed to other viewers.
  - `serializeRsvp` hides `invitedByUserId` from non-organiser viewers.
  - Close-friends visibility is now directionally correct: the filter checks the **attendee's** close-friends list (not the viewer's), via a new `getCloseFriendsOf(viewer, attendees[])` bridge query.
  - N+1 attendance lookup in the visibility filter is now a single batched `getAttendanceVisibilityBatch` query.
  - `listEvents` private filter is pushed into the SQL `WHERE` clause so page sizes are stable and `events_visibility_idx` is used.
  - Event text fields have explicit `maxLength` caps (title 200, description 5000, location/venue 500, category 100) to bound storage abuse.
  - `EventDetailPage`, `SettingsPage`, and Leaflet itself are now lazy-loaded so the home feed doesn't ship the map bundle.
  - Removed the `console.log` in `sendBlast` that leaked partial blast bodies to stdout.

  **Avatars on the event detail page** show a centralised green ring (`CLOSE_FRIEND_RING_CLASS` in `pulse/app/src/lib/ui.ts`) when the attendee has marked the viewer as a close friend. The ring is rendered by a shared `RsvpAvatar` component used by both `RsvpSection` and `RsvpModal` — change the constant in one place and every close-friend affordance updates.

## 0.5.1

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
  - @shared/db-utils@0.2.1

## 0.5.0

### Minor Changes

- 45248b2: feat: expand seed data with 20 users, social graph, event RSVPs

  - osn-db: 20 seed users with 25 connections and 3 close friends
  - pulse-db: `event_rsvps` table for tracking attendance
  - pulse-db: 15 seed events across 8 creators with 72 RSVPs
  - Fix effect version alignment across all packages (resolves pre-existing type errors)

## 0.4.0

### Minor Changes

- 05a9022: Add event ownership enforcement: `createdByUserId NOT NULL` on events, auth required for POST/PATCH/DELETE, ownership check (403) on mutating operations, `createdByName` derived server-side from JWT email claim, index on `created_by_user_id`, `updateEvent` eliminates extra DB round-trip.

## 0.3.0

### Minor Changes

- 89b104c: Add latitude/longitude columns to the events schema, store geocoordinates from Photon autocomplete in the create form, and display an "Open in Maps" link on each EventCard using coordinates when available or text-based search as a fallback.

## 0.2.1

### Patch Changes

- caafe67: Add realistic relative-timestamp seed data with full status distribution (1 finished, 3 ongoing, 5 upcoming) across varied categories; idempotent via onConflictDoNothing

## 0.2.0

### Minor Changes

- 880e762: Split `packages/db` into `packages/osn-db` (`@osn/db`) and `packages/pulse-db` (`@pulse/db`). Each app now owns its database layer: OSN Core owns user/session/passkey schema, Pulse owns events schema. Replace Valibot with Effect Schema in the events service — `effect/Schema` is used for service-layer domain validation and transforms (e.g. ISO string → Date), while Elysia TypeBox remains at the HTTP boundary for route validation and Eden type inference.

### Patch Changes

- 880e762: Add `@utils/db` package (`packages/utils-db`) with shared database utilities — `createDrizzleClient` and `makeDbLive` — eliminating boilerplate duplication between `@osn/db` and `@pulse/db`. Both db packages now delegate client creation and Layer setup to `@utils/db`. Also removes the unused singleton `client.ts` export from both db packages.
- Updated dependencies [880e762]
  - @utils/db@0.2.0
