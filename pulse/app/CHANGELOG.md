# @osn/pulse

## 0.16.7

### Patch Changes

- Updated dependencies [e01206c]
  - @osn/client@2.5.1
  - @osn/ui@1.5.1

## 0.16.6

### Patch Changes

- @pulse/api@0.24.4

## 0.16.5

### Patch Changes

- Updated dependencies [98320d5]
  - @pulse/api@0.24.3

## 0.16.4

### Patch Changes

- @pulse/api@0.24.2

## 0.16.3

### Patch Changes

- Updated dependencies [f569c7c]
  - @pulse/api@0.24.1

## 0.16.2

### Patch Changes

- Updated dependencies [6b14961]
- Updated dependencies [6b14961]
- Updated dependencies [6b14961]
  - @pulse/api@0.24.0
  - @osn/client@2.5.0
  - @osn/ui@1.5.0

## 0.16.1

### Patch Changes

- Updated dependencies [630e98f]
  - @pulse/api@0.23.6

## 0.16.0

### Minor Changes

- f62784d: Code-quality sweep: lint-config repair + convention fixes monorepo-wide.

  - oxlint config: pin rules that leaked in via an upstream category re-shuffle
    (`no-underscore-dangle` off — Effect `_tag` is idiomatic;
    `unicorn/consistent-function-scoping` off — boot-time factory modules and
    Effect-context DI make it noise; `no-await-in-loop` off in tests), raise
    `jsx-a11y/control-has-associated-label` depth for Solid control-flow
    wrappers. 463 → 21 warnings; the survivors are the deliberate aspirational
    jsx-a11y set.
  - S-M5 (osn): `/account` erasure endpoints now thread `clientIpConfig` +
    socket peer into per-IP rate-limit keying (spoofable XFF no longer picks
    the bucket; unresolved IPs are denied, S-M34 posture) — with route tests.
  - pulse/api + zap/api route factories now build their Effect layer graph once
    per factory via `ManagedRuntime` instead of `Effect.provide(dbLayer)` inside
    every request (convention: `osn/api/src/lib/route-runtime.ts`); dead
    pre-instantiated route-group exports removed.
  - Dead exports removed: `decodeSession` (@osn/client), `getHandleFromToken`
    (@pulse/app).
  - Assorted lint fixes: variable shadowing renames, unused imports, promise
    handling in `TurnstileWidget`, `toSorted` in tests.

### Patch Changes

- Updated dependencies [f62784d]
  - @osn/client@2.4.0
  - @pulse/api@0.23.5
  - @osn/ui@1.4.6

## 0.15.12

### Patch Changes

- 368e3e8: Performance audit sweep (versioned packages). No behavioural or security
  changes — fail-closed rate limiting, visibility gates, consent checks,
  single-use guarantees, and tenant scoping are preserved exactly.

  - `@zap/api`: `listChats` is cursor-paginated (default 50, max 100) with a
    composite `(createdAt, id)` keyset cursor (same-second creation bursts are
    never skipped) and caller-scoped cursors (unknown/foreign cursors
    rejected); `getChatMembers` is limit/offset-paginated (default 100, max 500) and skips its redundant existence load when the route has already
    asserted membership; both list responses carry `hasMore` (+ `nextCursor`
    for chats) continuation metadata; `addMember` checks the member cap with
    `COUNT(*)` instead of fetching every member row.
  - `@osn/api`: ceremony-store TTL sweep debounced to once per 30s (hard cap
    still enforced on every set); `beginRegistration`/`registerProfile`
    uniqueness probes collapsed to one round-trip via `UNION ALL` of two
    indexed single-table arms (an `OR` across the users-accounts join defeats
    SQLite's OR-optimization and plans as a full table scan);
    `sendConnectionRequest` reads run concurrently; `consumeRecoveryCode` is a
    single atomic conditional `UPDATE … RETURNING` (also closes the remaining
    check-then-act window); `countActiveRecoveryCodes` is a SQL aggregate that
    no longer fetches `code_hash` values; redundant accounts read moved out of
    the identified passkey-login path; per-call `TextEncoder` allocation and
    per-issuance `process.env` reads hoisted to module scope.
  - `@pulse/api`: status-transition persistence batched to one `UPDATE … WHERE
id IN (…)` per (from → to) group across all five list surfaces (was up to
    500 writes per GET on series instances); `updateSeries`/`cancelSeries`
    collapsed to single race-free `UPDATE … RETURNING`; `listTodayEvents`
    capped at 200 rows; RSVP routes thread the already-loaded event row into
    `listRsvps`/`rsvpCounts`/`latestRsvps`; `createEvent` uses `INSERT …
RETURNING`; `GET /events/:id/ics` sends `Cache-Control: private,
no-cache` + a weak ETag and honours `If-None-Match` (including `*` and
    multi-value lists) with 304 — every reuse revalidates through the
    visibility gate.
  - `@pulse/db`: new `event_rsvps_event_status_idx (event_id, status)`
    composite index; the subsumed single-column `event_rsvps_event_idx` is
    dropped (migration 0008).
  - `@osn/client`: `RegistrationClient.checkHandle` accepts an optional
    `AbortSignal` so debounced callers can cancel stale availability probes.
  - `@osn/ui`: `Register` and `CreateProfileForm` abort the previous in-flight
    handle check before issuing a new one and on unmount.
  - `@pulse/app`: Explore map resize handling is debounced (100 ms), grid
    geometry is memoized per size, and theme detection is a reactive
    `MutationObserver`-driven signal instead of a per-access DOM read.

- Updated dependencies [368e3e8]
  - @osn/client@2.3.4
  - @osn/ui@1.4.5
  - @pulse/api@0.23.4

## 0.15.11

### Patch Changes

- Updated dependencies [f4b9c6b]
  - @osn/client@2.3.3
  - @pulse/api@0.23.3
  - @osn/ui@1.4.4

## 0.15.10

### Patch Changes

- @pulse/api@0.23.2

## 0.15.9

### Patch Changes

- @pulse/api@0.23.1

## 0.15.8

### Patch Changes

- Updated dependencies [0a297de]
  - @osn/client@2.3.2
  - @osn/ui@1.4.3

## 0.15.7

### Patch Changes

- Updated dependencies [c981dee]
  - @osn/ui@1.4.2

## 0.15.6

### Patch Changes

- Updated dependencies [1dd9f6d]
  - @osn/client@2.3.1
  - @osn/ui@1.4.1

## 0.15.5

### Patch Changes

- Updated dependencies [47c83a6]
  - @osn/ui@1.4.0

## 0.15.4

### Patch Changes

- Updated dependencies [aed9d98]
- Updated dependencies [5055e1a]
- Updated dependencies [5055e1a]
- Updated dependencies [d81383d]
  - @pulse/api@0.23.0
  - @osn/ui@1.3.0
  - @osn/client@2.3.0

## 0.15.3

### Patch Changes

- Updated dependencies [f466a65]
  - @pulse/api@0.22.0

## 0.15.2

### Patch Changes

- af2cf69: Bring cire under the OSN oxlint + oxfmt conventions cleanly — cire was the
  source of 34 of the repo's 40 oxlint warnings; it is now warning-free under
  the shared `oxlintrc.json`.

  Lint fixes (behaviour-preserving):

  - `unicorn/no-array-sort` — replaced mutating `Array#sort()` with
    non-mutating `Array#toSorted()` in test assertions across `cire/api`
    (`claim`, `rsvp`, `spreadsheet` service + route tests).
  - `unicorn/prefer-add-event-listener` — `FileReader`/`script` `on*`
    assignments converted to `addEventListener(...)` in
    `cire/organiser` `ImportPanel`, `cire/web` `PinterestBoard`, and the
    `cire/web` calendar test.
  - `unicorn/consistent-function-scoping` — hoisted scope-independent
    helpers (`pad` in `cire/web/calendar`, `tooManyRows` / `cellTooLarge`
    in `cire/api/spreadsheet`) to module scope.
  - `no-console` — annotated the `cire/api` local-dev server banner
    (`local.ts`, a Bun shim, not the deployed Worker) with the repo's
    standard `eslint-disable-next-line no-console -- …` justification.

  Tooling parity:

  - The root `fmt` / `fmt:check` scripts now include `cire` (the `lint`
    script already covered it via `.`), so CI's format check enforces cire
    too. The two cire `astro.config.mjs` files were import-sorted to match.

  Also cleared the remaining 6 repo-wide oxlint warnings so the whole tree
  is warning-free under the shared config:

  - `@pulse/api` events feed — `Array#sort()` → `Array#toSorted()`.
  - `@pulse/app` Explore — hoisted `isDark` to module scope
    (`consistent-function-scoping`) and prefixed an unused mock param.
  - `@osn/api` outbound-arc + `@shared/osn-auth-client` jwks-cache test —
    justified `no-await-in-loop` disables where the sequential `await` is
    intentional (short-circuit on a configured stack / LRU access order
    under test), plus a hoisted test url helper.

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

- Updated dependencies [8aeddf1]
- Updated dependencies [af2cf69]
- Updated dependencies [04e0bf2]
  - @osn/ui@1.2.0
  - @pulse/api@0.21.1
  - @osn/client@2.2.1

## 0.15.1

### Patch Changes

- Updated dependencies [c3cca40]
  - @osn/client@2.2.0
  - @pulse/api@0.21.0
  - @osn/ui@1.1.2

## 0.15.0

### Minor Changes

- 5d2e145: Add a Share button to event detail with source attribution. The picker
  covers Instagram, Facebook, TikTok, X, WhatsApp, copy link, and a system
  share-sheet fallback. Shared URLs carry a `?source=…` param so when the
  recipient lands on the event we can record both first-touch (sticky) and
  last-touch attribution on the RSVP row, plus per-platform share-invoked
  and exposure metrics. Organisers' own self-RSVPs and self-views skip
  attribution. Share and exposure endpoints are unauthenticated and
  rate-limited per IP.

### Patch Changes

- Updated dependencies [5d2e145]
  - @pulse/api@0.20.0

## 0.14.0

### Minor Changes

- 34a912f: Pulse calendar page: a vertical-timeline agenda (`/calendar`) listing the events you're hosting or have RSVP'd Going / Maybe to, grouped by day with a continuous timeline axis on the left. Maybe RSVPs surface an inline reminder to confirm (I'm going) or drop (Can't make it). Backed by a new auth-gated `GET /events/calendar` endpoint + `listMyCalendarEvents` service (instrumented with the `pulse.calendar.events.fetched` metric and a `pulse.calendar.list_mine` span). The Calendar tab in the Explore nav now routes here.

  Also renames the RSVP "interested" status to "maybe" end-to-end (DB enum value, API wire value, metrics, and UI) — no legacy alias, as nothing is deployed yet. The per-event `allowInterested` toggle column keeps its name.

### Patch Changes

- Updated dependencies [34a912f]
  - @pulse/api@0.19.0

## 0.13.0

### Minor Changes

- 1f61fc4: Add a venue detail page (initially scoped to clubs) plus a clickable
  venue layer on the Explore map. Venues are namespaced under OSN
  organisations so the same handle (and name) can recur across orgs.

  - DB: new `venues` and `event_lineup` tables and a nullable
    `events.venue_id` FK. `venues` rows carry `org_handle` + `handle`
    with a unique `(org_handle, handle)` index; `id` is opaque (`ven_*`)
    and not URL-addressable.
  - API: routes nest under `/venues/:orgHandle/:venueHandle` —
    `GET /venues` (index, feeds the map; tracked for bbox-aware
    replacement), `GET /venues/:orgHandle/:venueHandle`, `/events`, and
    `/events/:eventId/lineup`. Effect services with `pulse.venue.*`
    spans and bounded-cardinality metrics for the detail, events list,
    and lineup surfaces.
  - Frontend page at `/venues/:orgHandle/:venueHandle` with a vertical
    mono-time lineup timeline, a snap-scroll event carousel, a real-time
    open/closed badge (computed in the venue's timezone, handles slots
    crossing midnight), an "Open in Maps" button, and icon links to
    website + Instagram. Discovery routes linking _into_ the page are
    intentionally deferred — the Explore map is the first such surface.
  - Explore map: new venue pin layer wrapped in `<A>` to the venue page.
    When a visible event pin sits at the same venue, the diamond is
    hidden and the event-pin popover gains a "See venue →" CTA. Popover
    is now pointer-event aware with a hover-grace timer so the button is
    reachable. `Icon` component promoted from `explore/` to `components/`
    with `globe` + `instagram` glyphs added.

### Patch Changes

- Updated dependencies [1f61fc4]
  - @pulse/api@0.18.0

## 0.12.1

### Patch Changes

- Updated dependencies [1a4e9d5]
- Updated dependencies [051daa8]
  - @pulse/api@0.17.1

## 0.12.0

### Minor Changes

- dd742dd: Pulse first-run onboarding: six-step `/welcome` flow with themed coral illustrations (welcome rings, editorial map, interest constellation, location pin drop, notifications ember, finish date stamp). Captures interests, location/notifications permissions, and reminder opt-in. Account-keyed server-side via a new `pulse_account_onboarding` table + `pulse_profile_accounts` mapping cache + new `GET /graph/internal/profile-account` ARC endpoint on `osn/api` — preserves the multi-account privacy invariant (accountId never on the wire). Server-side first-run gate redirects new users to `/welcome` and is idempotent on the completion POST. See `wiki/systems/pulse-onboarding.md`.

### Patch Changes

- Updated dependencies [dd742dd]
  - @pulse/api@0.17.0

## 0.11.1

### Patch Changes

- 073238d: Migrate close friends from OSN core to Pulse.

  Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
  app can implement its own close-friends-style list against the OSN connection
  graph; OSN core retains only `connections` and `blocks`.

  What it does in Pulse:

  - **Feed boost.** Events organised by a close friend surface higher in
    `listEvents` (stable partition: chronological order preserved within each
    bucket; not applied for anonymous viewers).
  - **Hosting affordance.** The existing RSVP avatar ring — driven by an
    attendee having marked the viewer as a close friend — is preserved end-to-end,
    now backed by the local `pulse_close_friends` table.
  - **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
    header avatar dropdown).

  Surface changes:

  - New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
    routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
    `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
  - Removed: OSN-core `close_friends` table, services, routes (user-facing
    `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
    graph close-friend SDK methods on `@osn/client`, the close-friends tab in
    `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
    and the `GraphCloseFriendAction` observability attribute.
  - Connection projection now includes `id` so cross-DB references (Pulse adding
    by profile id) work without duplicating handle→id resolution.

  Pre-launch: the OSN `close_friends` table is dropped outright; seed data
  updated. No migration path or backwards-compatibility shims.

- Updated dependencies [073238d]
  - @pulse/api@0.16.1
  - @osn/client@2.1.1
  - @osn/ui@1.1.1

## 0.11.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [dd52579]
  - @pulse/api@0.16.0

## 0.10.4

### Patch Changes

- Updated dependencies [f071cd9]
  - @pulse/api@0.15.2

## 0.10.3

### Patch Changes

- 7a075c7: Pulse: replace `csp: null` in `tauri.conf.json` with a strict Content-Security-Policy allowlist. `connect-src` permits Tauri IPC, `photon.komoot.io` (geocoding) and the local OSN/Pulse API ports; `img-src` permits `*.tile.openstreetmap.org` for Leaflet tiles. Closes S-L3.

## 0.10.2

### Patch Changes

- Updated dependencies [878e6c4]
  - @pulse/api@0.15.1

## 0.10.1

### Patch Changes

- 3b763e9: Add optional `price` to Pulse events.

  - `events.price_amount` (integer, nullable, minor units) + `events.price_currency` (text, nullable, ISO 4217) columns.
  - API accepts `priceAmount` in major units (decimal, cap 99999.99) + `priceCurrency` from a curated allowlist (USD, EUR, GBP, CAD, AUD, JPY). Enforced "both set or both null" invariant at the service layer.
  - Create-event form gets a price + currency input; badge shows "Free" when unset or 0, otherwise `Intl.NumberFormat`-formatted value.

- Updated dependencies [3b763e9]
  - @pulse/api@0.15.0

## 0.10.0

### Minor Changes

- a326b65: Introduce recurring event series.

  - New `event_series` table + `series_id`/`instance_override` columns on `events`, with migration `0001_recurring_events.sql`.
  - New `/series` API surface: `POST /series`, `GET /series/:id`, `GET /series/:id/instances`, `PATCH /series/:id` (scope: `this_and_following` | `all_future`), `DELETE /series/:id`.
  - Reduced-grammar RRULE expander (`FREQ=WEEKLY|MONTHLY`, `INTERVAL`, `BYDAY`, `COUNT`, `UNTIL`) capped at `MAX_SERIES_INSTANCES = 260`.
  - Series-level edits propagate to non-override future instances; patching a single instance flips `instanceOverride=true` so subsequent bulk edits skip it.
  - `pulse.series.*` metrics (created / updated / cancelled / instances_materialized / rrule.rejected) with bounded string-literal attribute unions.
  - Seed fixtures now include a weekly yoga series (with an overridden + cancelled instance) and a monthly book club.
  - Frontend: "Part of a series" badge on event detail, repeat icon on event cards, new `/series/:id` page with Upcoming / Past tabs — all anchored on `pulse/DESIGN.md` tokens.

### Patch Changes

- Updated dependencies [a326b65]
  - @pulse/api@0.14.0

## 0.9.2

### Patch Changes

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

- Updated dependencies [9de67a2]
  - @pulse/api@0.13.0

## 0.9.1

### Patch Changes

- @pulse/api@0.12.2

## 0.9.0

### Minor Changes

- 516c579: Add Explore page with editorial nav, category-filtered event cards, and heatmap map pane. Replaces EventList as home route. Extends design tokens with warm oklch accents and Instrument Serif typography.

## 0.8.20

### Patch Changes

- Updated dependencies [b57f0f6]
  - @pulse/api@0.12.1

## 0.8.19

### Patch Changes

- Updated dependencies [1d68593]
  - @osn/client@2.1.0
  - @osn/ui@1.1.0

## 0.8.18

### Patch Changes

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
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @osn/client@2.0.1
  - @osn/ui@1.0.1
  - @pulse/api@0.12.0

## 0.8.17

### Patch Changes

- 6387b98: Passkey-primary login (M-PK). WebAuthn (passkey or security key) is the only primary login factor. OTP and magic-link primary login, and the `enrollmentToken` JWT machinery, have been removed. Registration is WebAuthn-gated and first-credential enrollment is mandatory; `deletePasskey` refuses unconditionally if it would leave zero credentials. The "Lost your passkey?" path (recovery codes) is the single escape hatch.

  Hardenings from the security review: **S-H1** step-up gate on `/passkey/register/*` when the account already has ≥1 passkey + `security_events{passkey_register}` audit row + best-effort email notification + server-derived session token (no user-supplied body field). **S-H2** options/verifier `userVerification` alignment (`required` on both sides; rejects UP-only U2F). **S-M1** `/login/passkey/begin` returns a uniform synthetic response for unknown identifiers, closing the enumeration oracle. **S-M2** access tokens carry `aud: "osn-access"` and `verifyAccessToken` asserts it.

  **Breaking — @osn/api**

  - Removed routes: `POST /login/otp/begin`, `POST /login/otp/complete`, `POST /login/magic/begin`, `POST /login/magic/verify`.
  - Removed service methods: `beginOtp`, `completeOtpDirect`, `beginMagic`, `verifyMagicDirect`, `issueEnrollmentToken`, `verifyEnrollmentToken`.
  - `/passkey/register/{begin,complete}` now authenticates via the normal access token; enrollment tokens are gone.
  - `/passkey/register/begin` accepts an optional `step_up_token` body field or `X-Step-Up-Token` header; **required** when the account already has ≥1 passkey (S-H1).
  - `/passkey/register/complete` body no longer accepts `session_token`; the server derives it from the HttpOnly cookie (S-H1).
  - `/register/complete` response drops `enrollment_token`.
  - `/login/passkey/begin` now returns `200 { options }` in all cases (including unknown identifier) — previously 400 on unknown (S-M1).
  - Access tokens carry `aud: "osn-access"` (S-M2).
  - `AuthConfig` drops `magicLinkBaseUrl` / `magicTtl`; adds `passkeyRegisterAllowedAmr` (default `["webauthn", "otp"]`). `AuthRateLimiters` drops `otpBegin`, `otpComplete`, `magicBegin`.
  - `SecurityEventKind` union adds `"passkey_register"`.
  - `deletePasskey` refuses to drop below 1 passkey regardless of recovery-code state.
  - WebAuthn registration options use `residentKey: "preferred"` + `userVerification: "required"`; both login paths use `userVerification: "required"` to match the verifier (S-H2).

  **Breaking — @osn/client**

  - `LoginClient` now only exposes `passkeyBegin` / `passkeyComplete`. `otpBegin`, `otpComplete`, `magicBegin`, `magicVerify` removed.
  - `CompleteRegistrationResult` no longer contains `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` / `passkeyRegisterComplete` take `accessToken` instead of `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` additionally accepts an optional `stepUpToken` — required when adding a passkey to an account that already has one (S-H1). The bootstrap first-passkey flow from `completeRegistration` still works without it.

  **Breaking — @osn/ui**

  - `<SignIn>` now requires a `recoveryClient: RecoveryClient` prop. The component is WebAuthn-only; it renders an informational screen when WebAuthn is unsupported, and exposes a "Lost your passkey?" link into `<RecoveryLoginForm>`.
  - `<Register>` is WebAuthn-gated. No flow path exists without WebAuthn support, and the "Skip for now" button is gone.
  - `<MagicLinkHandler>` deleted.

  **@shared/observability (minor)**

  - `AuthMethod` narrowed to `"passkey" | "recovery_code" | "refresh"`.
  - `AuthRateLimitedEndpoint` dropped `otp_begin`, `otp_complete`, `magic_begin`.

  **@pulse/app / @osn/social (patch)**

  - Pass a `recoveryClient` into `<SignIn>`; `<MagicLinkHandler>` removed from the root layout.

- Updated dependencies [6387b98]
  - @osn/client@2.0.0
  - @osn/ui@1.0.0
  - @pulse/api@0.11.10

## 0.8.16

### Patch Changes

- Updated dependencies [b1d5980]
  - @osn/client@1.1.0
  - @osn/ui@0.11.0
  - @pulse/api@0.11.9

## 0.8.15

### Patch Changes

- c04163d: Remove legacy OAuth authorization-code / PKCE flow.

  The first-party `/login/*` endpoints (Session + PublicProfile returned inline)
  are now the only sign-in surface. The following are gone:

  - Server routes `GET /authorize`, `POST /token` `grant_type=authorization_code`,
    `POST /passkey/login/{begin,complete}`, `POST /otp/{begin,complete}`,
    `POST /magic/begin`, `GET /magic/verify`
  - Service methods `exchangeCode`, `issueCode`, `completePasskeyLogin`,
    `completeOtp`, `verifyMagic`, `validateRedirectUri`; `AuthConfig.allowedRedirectUris`
  - Client API `OsnAuthService.startLogin` / `handleCallback`, module `@osn/client/pkce`,
    errors `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`;
    `OsnAuthConfig.clientId`
  - Solid context methods `login` / `handleCallback`
  - `<CallbackHandler />` components in `@pulse/app` and `@osn/social`
  - Helper files `osn/api/src/lib/html.ts`, `osn/api/src/lib/crypto.ts`
  - Rate-limiter slot `magicVerify` and `AuthRateLimitedEndpoint` variant `magic_verify`

  OIDC discovery now reports `grant_types_supported: ["refresh_token"]` only.
  Magic-link emails point at `/login/magic/verify` (consumed client-side by
  `MagicLinkHandler`).

- Updated dependencies [c04163d]
  - @osn/client@1.0.0
  - @osn/ui@0.10.1
  - @pulse/api@0.11.8

## 0.8.14

### Patch Changes

- Updated dependencies [811eda4]
  - @osn/client@0.10.0
  - @osn/ui@0.10.0
  - @pulse/api@0.11.7

## 0.8.13

### Patch Changes

- @pulse/api@0.11.6

## 0.8.12

### Patch Changes

- Updated dependencies [dc8c384]
  - @osn/client@0.9.0
  - @osn/ui@0.9.0
  - @pulse/api@0.11.5

## 0.8.11

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/client@0.8.0
  - @osn/ui@0.8.0
  - @pulse/api@0.11.4

## 0.8.10

### Patch Changes

- Updated dependencies [2d5cce9]
  - @osn/client@0.7.0
  - @osn/ui@0.7.4
  - @pulse/api@0.11.3

## 0.8.9

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/client@0.6.0
  - @osn/ui@0.7.3
  - @pulse/api@0.11.2

## 0.8.8

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/client@0.5.1
  - @osn/ui@0.7.2
  - @pulse/api@0.11.1

## 0.8.7

### Patch Changes

- Updated dependencies [0edef32]
  - @pulse/api@0.11.0

## 0.8.6

### Patch Changes

- @pulse/api@0.10.2

## 0.8.5

### Patch Changes

- Updated dependencies [177eeea]
  - @pulse/api@0.10.1

## 0.8.4

### Patch Changes

- Updated dependencies [fe55da8]
  - @pulse/api@0.10.0

## 0.8.3

### Patch Changes

- @pulse/api@0.9.10

## 0.8.2

### Patch Changes

- @pulse/api@0.9.9

## 0.8.1

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/client@0.5.0
  - @pulse/api@0.9.8
  - @osn/ui@0.7.1

## 0.8.0

### Minor Changes

- e2f4c25: Add DropdownMenu component to @osn/ui; redesign Pulse header with full-width layout, expanding create-event button, and avatar dropdown menu

### Patch Changes

- Updated dependencies [e2f4c25]
  - @osn/ui@0.7.0

## 0.7.12

### Patch Changes

- Updated dependencies [d691034]
  - @osn/ui@0.6.0
  - @pulse/api@0.9.7

## 0.7.11

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @osn/ui@0.5.2
  - @pulse/api@0.9.6

## 0.7.10

### Patch Changes

- @pulse/api@0.9.5

## 0.7.9

### Patch Changes

- aa256af: Inline base: variant prefixes for Tailwind v4 JIT compatibility; add cursor-pointer to Button; deprecate bx(). Add @source directive for UI library scanning; wrap auth forms in Dialog modals with mutual exclusion.
- Updated dependencies [aa256af]
  - @osn/ui@0.5.1

## 0.7.8

### Patch Changes

- @pulse/api@0.9.4

## 0.7.7

### Patch Changes

- 33c6ba6: Multi-account P5: Profile UI components

  Add ProfileSwitcher (popover with profile list, switch, delete, create), CreateProfileForm, and ProfileOnboarding components to @osn/ui. Integrate ProfileSwitcher into Pulse event list header and ProfileOnboarding into Pulse settings page.

- Updated dependencies [33c6ba6]
  - @osn/ui@0.5.0

## 0.7.6

### Patch Changes

- Updated dependencies [fcd8e8f]
  - @osn/client@0.4.0
  - @osn/ui@0.4.2

## 0.7.5

### Patch Changes

- @pulse/api@0.9.3

## 0.7.4

### Patch Changes

- @pulse/api@0.9.2

## 0.7.3

### Patch Changes

- Updated dependencies [f2fbc2a]
  - @osn/client@0.3.2
  - @osn/ui@0.4.1

## 0.7.2

### Patch Changes

- 7030545: Migrate UI components to Zaidan (shadcn-style component library for SolidJS)

  Adds Kobalte-backed headless UI primitives (Button, Input, Label, Card, Badge, Dialog, Popover, Tabs, RadioGroup, Checkbox, Textarea, Avatar) to @osn/ui as the shared design system. Replaces inline Tailwind class patterns across both @osn/ui auth components and @pulse/app with these reusable primitives.

- Updated dependencies [7030545]
  - @osn/ui@0.4.0

## 0.7.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.
- Updated dependencies [5520d90]
  - @osn/client@0.3.1
  - @osn/ui@0.3.1
  - @pulse/api@0.9.1

## 0.7.0

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

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/client@0.3.0
  - @osn/ui@0.3.0
  - @pulse/api@0.9.0

## 0.6.11

### Patch Changes

- 098fd01: Upgrade vite from v6 to v8 with devtools, bump astro to 6.1.5
- Updated dependencies [098fd01]
  - @osn/ui@0.2.2

## 0.6.10

### Patch Changes

- @pulse/api@0.8.2

## 0.6.9

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/client@0.2.1
  - @osn/ui@0.2.1
  - @pulse/api@0.8.1

## 0.6.8

### Patch Changes

- 3df372a: Upgrade oxlint (0.16 -> 1.59) and oxfmt (0.20 -> 0.44) with improved configuration: add vitest, node, jsx-a11y plugins; enable perf category; add import sorting and Tailwind class sorting; fix lefthook pre-commit auto-fix

## 0.6.7

### Patch Changes

- Updated dependencies [7349512]
  - @pulse/api@0.8.0

## 0.6.6

### Patch Changes

- @pulse/api@0.7.6

## 0.6.5

### Patch Changes

- @pulse/api@0.7.5

## 0.6.4

### Patch Changes

- @pulse/api@0.7.4

## 0.6.3

### Patch Changes

- Updated dependencies [e8b4f93]
  - @pulse/api@0.7.3

## 0.6.2

### Patch Changes

- Updated dependencies [f87d7d2]
  - @pulse/api@0.7.2

## 0.6.1

### Patch Changes

- @pulse/api@0.7.1

## 0.6.0

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

### Patch Changes

- Updated dependencies [ebaf56a]
  - @pulse/api@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [cab97ca]
  - @pulse/api@0.6.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [e82d793]
  - @pulse/api@0.5.0

## 0.4.0

### Minor Changes

- 97f35e5: Add shared in-app sign-in and registration across the OSN stack.

  **`@osn/core`** — new first-party `/login/*` endpoints that return a
  `Session + PublicUser` directly, mirroring the existing `/register/*`
  flow with no PKCE round-trip:

  - `POST /login/passkey/{begin,complete}`
  - `POST /login/otp/{begin,complete}` (enumeration-safe: `begin` always
    returns `{ sent: true }`)
  - `POST /login/magic/{begin}` + `GET /login/magic/verify?token=…`

  Service layer refactored to extract `verifyPasskeyAssertion`,
  `verifyOtpCode`, and `consumeMagicToken` helpers so the direct-session
  variants (`completePasskeyLoginDirect`, `completeOtpDirect`,
  `verifyMagicDirect`) share verification logic with the existing
  code-issuing variants. The hosted `/authorize` HTML + PKCE path is
  unchanged and remains the third-party OAuth entry point.

  **`@osn/client`** — new `createLoginClient({ issuerUrl })` factory
  mirroring `createRegistrationClient`, with `passkeyBegin/Complete`,
  `otpBegin/Complete`, `magicBegin/Verify` methods. Throws `LoginError`
  on non-2xx. Returned sessions are already parsed via `parseTokenResponse`
  and ready to pass to `AuthProvider.adoptSession`.

  **`@osn/ui`** — new shared SolidJS components under `@osn/ui/auth`:

  - `<Register />` — migrated from `@pulse/app` with a new `client` prop
    so it's decoupled from any specific app's env config.
  - `<SignIn />` — new three-tab sign-in (passkey / OTP / magic) driving
    the new `/login/*` endpoints through an injected `LoginClient`. Auto-
    falls-back to OTP when WebAuthn is unsupported.
  - `<MagicLinkHandler />` — invisible root-level component that exchanges
    a `?token=…` query param for a session and clears the URL.

  Package now pulls in the SolidJS + Vitest + @simplewebauthn/browser
  devDeps it needs to actually host these components.

  **`@pulse/app`** — replaces the old `useAuth().login()` redirect to
  `/authorize` with an in-app `<SignIn />` modal. Imports `<Register>`,
  `<SignIn>`, and `<MagicLinkHandler>` from `@osn/ui/auth/*`; shared
  `RegistrationClient` and `LoginClient` instances live in
  `src/lib/authClients.ts` and are injected as props.

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/ui@0.2.0
  - @osn/client@0.2.0
  - @pulse/api@0.4.4

## 0.3.0

### Minor Changes

- cf57969: Add an email-verified registration flow end-to-end with passkey enrolment, plus a security redesign that addresses the critical findings raised during review.

  **`@osn/core` — new endpoints + service work**

  - `POST /register/begin` — validates email + handle, normalises email to lowercase, generates an unbiased 6-digit OTP via rejection sampling, stores a pending registration in a bounded (10k cap), swept-on-insert in-memory map, and emails the OTP. Always returns `{ sent: true }` regardless of conflict to remove the user-enumeration oracle (S-M1/S-M26). Refuses to overwrite a non-expired pending entry to prevent griefing of in-progress registrations (S-M2/S-M23).
  - `POST /register/complete` — verifies the OTP using a constant-time comparison (S-M4/S-M25), enforces a 5-attempts-then-wipe brute-force cap (S-H1 partial), inserts the user using the DB unique constraint as the source of truth (no TOCTOU; the pending entry is only deleted after a successful insert — S-H4/S-H10), and returns access + refresh tokens **directly** alongside a single-use enrollment token. The registration code path no longer touches `/token` so it does not depend on the pre-existing PKCE bypass at `/token` (tracked separately as S-H4/S-H9).
  - New `issueEnrollmentToken` / `verifyEnrollmentToken` service helpers — short-lived (5 min) JWTs of `type: "passkey-enroll"`, single-use via an in-memory consumed-jti set with opportunistic sweep.
  - `POST /passkey/register/{begin,complete}` now accept an `Authorization: Bearer <token>` header where the token is either an enrollment token or a normal access token; the token's `sub` is compared against the body `userId` and a mismatch returns `401` (S-C1/S-H5 partial). The legacy unauth'd path is preserved with a deprecation warning so the hosted `/authorize` HTML page still works; removing it is tracked in the security backlog.
  - New `publicError()` route helper maps Effect-tagged errors to opaque public payloads (`invalid_request`, `internal_error`) and logs the underlying cause server-side (S-H5/S-M6/S-M4).
  - Dev-only `console.log` of OTP codes is now gated on `NODE_ENV !== "production"` (S-M3/S-M22).

  **`@osn/client` — RegistrationClient redesign**

  - `createRegistrationClient` exposes `checkHandle`, `beginRegistration`, `completeRegistration`, `passkeyRegisterBegin`, `passkeyRegisterComplete`. **`exchangeAuthCode` is gone** — `completeRegistration` now returns a parsed `Session` ready for `AuthProvider.adoptSession` plus an `enrollmentToken`. Both passkey calls accept the enrollment token and send it as `Authorization: Bearer <token>`.
  - New `OsnAuth.setSession` + Solid `AuthProvider.adoptSession` for installing a session obtained out-of-band by the registration flow.

  **`@osn/pulse` — Register component**

  - Multi-step UI: details (email + handle + display name with debounced live availability check) → 6-digit OTP → optional passkey enrolment → done.
  - `adoptSession` is called immediately after OTP verification, **before** any passkey work — the user is signed in regardless of whether they go on to set up a passkey, so a flaky WebAuthn ceremony or an unsupported environment can no longer leave them stranded.
  - WebAuthn feature-detection via `browserSupportsWebAuthn()`; the passkey step is skipped entirely (and the UI jumps straight to "done") on environments without WebAuthn — currently Tauri's iOS webview, until we ship the native plugin.
  - Imperative skip path replacing the previous `createEffect` (P-I10), inlined `detailsValid` accessor (P-I11), module-scope `RegistrationClient` (P-I12).
  - Wired into `EventList` as a "Create account" button next to "Sign in with OSN".

  **Test coverage** (277 tests total, +58 from the previous PR baseline)

  - Service-level: happy path, lowercase normalisation, no-row-before-verify, ValidationError on bad inputs, enumeration-resistant begin, refuse-to-overwrite pending entry, wrong OTP, no-pending error, single-use replay, brute-force attempt cap, TOCTOU loss against legacy `/register`, enrollment token issue/verify/consume, replay rejection, type-claim discrimination.
  - Route-level: complete shape assertions, enumeration-resistant 200 responses, complete-without-begin, replay attack, reserved handle availability, Authorization gating with valid enrollment token / valid access token / mismatched sub / invalid bearer / legacy unauth'd path, enrollment-token consumption on `/complete`.
  - Client unit tests: URL composition, body shapes, Authorization header propagation, RegistrationError on non-OK, trailing-slash issuerUrl normalisation.
  - Solid `AuthProvider.adoptSession` round-trip test (real provider, harness component, asserts both `useAuth().session()` reactivity and `localStorage` persistence).
  - Pulse Register component test: input sanitisation, debounced availability with stale-result guard, `detailsValid` gating during `checking`, OTP digit-only clamp, immediate `adoptSession` after OTP, happy passkey enrolment with enrollment token propagation, "Skip for now" → done, WebAuthn-unsupported jump-to-done, Cancel.

### Patch Changes

- Updated dependencies [cf57969]
  - @osn/core@0.4.0
  - @osn/client@0.1.0

## 0.2.11

### Patch Changes

- Updated dependencies [d8e3559]
  - @osn/api@0.4.3

## 0.2.10

### Patch Changes

- Updated dependencies [3a0196b]
  - @osn/core@0.3.2

## 0.2.9

### Patch Changes

- @osn/core@0.3.1
- @osn/api@0.4.2

## 0.2.8

### Patch Changes

- Updated dependencies [623ad9f]
  - @osn/core@0.3.0

## 0.2.7

### Patch Changes

- 9caa8c7: Add user handle system

  Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

  - **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
  - **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
  - **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
  - **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility

- Updated dependencies [9caa8c7]
  - @osn/core@0.2.0
  - @osn/api@0.4.1

## 0.2.6

### Patch Changes

- Updated dependencies [05a9022]
  - @osn/api@0.4.0
  - @osn/core@0.1.1

## 0.2.5

### Patch Changes

- 89b104c: Add latitude/longitude columns to the events schema, store geocoordinates from Photon autocomplete in the create form, and display an "Open in Maps" link on each EventCard using coordinates when available or text-based search as a fallback.
- Updated dependencies [89b104c]
  - @osn/api@0.3.0

## 0.2.4

### Patch Changes

- @osn/api@0.2.3

## 0.2.3

### Patch Changes

- b8a40bc: Add toast notifications for event create, delete, and error states using solid-toast

## 0.2.2

### Patch Changes

- a9329a6: Refactor App.tsx into focused modules: lib/types.ts, lib/auth.ts, components/CallbackHandler.tsx, components/CreateEventForm.tsx, components/EventCard.tsx, components/EventList.tsx

## 0.2.1

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

- Updated dependencies [75f801b]
  - @osn/core@0.1.0
  - @osn/client@0.0.3
  - @osn/api@0.2.2

## 0.2.0

### Minor Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

### Patch Changes

- Updated dependencies [7d3f9dd]
  - @osn/api@0.2.1

## 0.1.1

### Patch Changes

- 880e762: Add @osn/client package with OAuth 2.0 + PKCE auth core, SolidJS and React adapters. Wire AuthProvider into Pulse.
- Updated dependencies [880e762]
- Updated dependencies [880e762]
  - @osn/client@0.0.2
  - @osn/api@0.2.0

## 0.1.0

### Minor Changes

- 51abbcc: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

### Patch Changes

- Updated dependencies [51abbcc]
  - @osn/api@0.1.1

## 0.0.2

### Patch Changes

- ade0a12: Remnant @solidjs/start bugs
