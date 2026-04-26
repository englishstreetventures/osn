# @pulse/db

## 0.12.2

### Patch Changes

- dd52579: Event discovery — unified "What's on" feed.

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

## 0.12.1

### Patch Changes

- f071cd9: Extract `@pulse/db/testing` helper so adding a column is a one-file change.

  - New `@pulse/db/testing` export: `createSchemaSql()` derives `CREATE TABLE` + `CREATE INDEX` statements directly from the live Drizzle schema (FK-respecting topological order), and `applySchema(sqlite)` applies them to an in-memory SQLite handle.
  - Replaces four hand-rolled DDL blocks in `pulse/db/tests/schema.test.ts`, `pulse/db/tests/seed.test.ts`, `pulse/api/tests/helpers/db.ts`, and `pulse/api/tests/services/zapBridge.test.ts` (pulse side) with `applySchema(sqlite)`.
  - Drift-guard regression test asserts every schema table appears in the emitted SQL and that all declared indexes exist in the materialised in-memory database.

  No runtime behaviour change — test infrastructure only.

## 0.12.0

### Minor Changes

- 3b763e9: Add optional `price` to Pulse events.

  - `events.price_amount` (integer, nullable, minor units) + `events.price_currency` (text, nullable, ISO 4217) columns.
  - API accepts `priceAmount` in major units (decimal, cap 99999.99) + `priceCurrency` from a curated allowlist (USD, EUR, GBP, CAD, AUD, JPY). Enforced "both set or both null" invariant at the service layer.
  - Create-event form gets a price + currency input; badge shows "Free" when unset or 0, otherwise `Intl.NumberFormat`-formatted value.

## 0.11.0

### Minor Changes

- a326b65: Introduce recurring event series.

  - New `event_series` table + `series_id`/`instance_override` columns on `events`, with migration `0001_recurring_events.sql`.
  - New `/series` API surface: `POST /series`, `GET /series/:id`, `GET /series/:id/instances`, `PATCH /series/:id` (scope: `this_and_following` | `all_future`), `DELETE /series/:id`.
  - Reduced-grammar RRULE expander (`FREQ=WEEKLY|MONTHLY`, `INTERVAL`, `BYDAY`, `COUNT`, `UNTIL`) capped at `MAX_SERIES_INSTANCES = 260`.
  - Series-level edits propagate to non-override future instances; patching a single instance flips `instanceOverride=true` so subsequent bulk edits skip it.
  - `pulse.series.*` metrics (created / updated / cancelled / instances_materialized / rrule.rejected) with bounded string-literal attribute unions.
  - Seed fixtures now include a weekly yoga series (with an overridden + cancelled instance) and a monthly book club.
  - Frontend: "Part of a series" badge on event detail, repeat icon on event cards, new `/series/:id` page with Upcoming / Past tabs — all anchored on `pulse/DESIGN.md` tokens.

## 0.10.0

### Minor Changes

- 9de67a2: Pulse: prompt for max event duration + new `maybe_finished` event status.

  Organisers creating an event now see a set of duration presets (1h / 2h / 4h /
  8h / All day) when the end time is left blank, plus a hint that an event
  without an explicit end time will be marked **maybe finished** after 8 hours
  and **automatically closed** after 12 hours. Organisers can manually close an
  event at any time.

  Schema: adds `"maybe_finished"` to the `events.status` enum (pure TS — no SQL
  migration; the column is plain text). The `EventStatus` union in
  `@shared/observability` and the service/route Effect + TypeBox schemas are
  updated in lockstep.

  Server: `deriveStatus` in `pulse/api/src/services/events.ts` now auto-
  transitions ongoing events with no `endTime` to `"maybe_finished"` at 8h past
  `startTime` and to `"finished"` at 12h. Events with an explicit `endTime`
  keep the original single-transition behaviour, and the 48h
  `MAX_EVENT_DURATION_HOURS` cap is enforced on both `POST /events` and
  `PATCH /events/:id` (including patches that change only `startTime` or only
  `endTime`) — rejections return 422 and emit
  `metricEventValidationFailure(op, "duration_exceeds_max")`.

## 0.9.2

### Patch Changes

- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @shared/db-utils@0.2.3

## 0.9.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.

## 0.9.0

### Minor Changes

- f5c1780: feat: add multi-account schema foundation (accounts table, userId → profileId rename)

  Introduces the `accounts` table as the authentication principal (login entity) and renames
  `userId` to `profileId` across all packages to establish the many-profiles-per-account model.

  Key changes:

  - New `accounts` table with `id`, `email`, `maxProfiles`
  - `users` table gains `accountId` (FK → accounts) and `isDefault` fields
  - `passkeys` re-parented from users to accounts (`accountId` FK)
  - All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
  - Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
  - Registration flow creates account + first profile atomically

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
