# @osn/api

## 0.16.0

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
  - @pulse/db@0.12.2

## 0.15.2

### Patch Changes

- f071cd9: Extract `@pulse/db/testing` helper so adding a column is a one-file change.

  - New `@pulse/db/testing` export: `createSchemaSql()` derives `CREATE TABLE` + `CREATE INDEX` statements directly from the live Drizzle schema (FK-respecting topological order), and `applySchema(sqlite)` applies them to an in-memory SQLite handle.
  - Replaces four hand-rolled DDL blocks in `pulse/db/tests/schema.test.ts`, `pulse/db/tests/seed.test.ts`, `pulse/api/tests/helpers/db.ts`, and `pulse/api/tests/services/zapBridge.test.ts` (pulse side) with `applySchema(sqlite)`.
  - Drift-guard regression test asserts every schema table appears in the emitted SQL and that all declared indexes exist in the materialised in-memory database.

  No runtime behaviour change — test infrastructure only.

- Updated dependencies [f071cd9]
  - @pulse/db@0.12.1

## 0.15.1

### Patch Changes

- 878e6c4: Fix `pulse-api` crashing at boot when `osn/api` is not yet reachable. `startKeyRotation()` now distinguishes network failures (explicit allowlist of Bun/Node codes: `ConnectionRefused`, `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`) from configuration errors: in local dev it logs a warning and schedules a background retry with exponential backoff (5 s → 5 min, ±1 s symmetric jitter) instead of exiting, so `bun run dev:pulse` tolerates either service starting first. Non-local envs and HTTP 4xx/5xx responses still fail fast so misconfiguration is surfaced immediately.

## 0.15.0

### Minor Changes

- 3b763e9: Add optional `price` to Pulse events.

  - `events.price_amount` (integer, nullable, minor units) + `events.price_currency` (text, nullable, ISO 4217) columns.
  - API accepts `priceAmount` in major units (decimal, cap 99999.99) + `priceCurrency` from a curated allowlist (USD, EUR, GBP, CAD, AUD, JPY). Enforced "both set or both null" invariant at the service layer.
  - Create-event form gets a price + currency input; badge shows "Free" when unset or 0, otherwise `Intl.NumberFormat`-formatted value.

### Patch Changes

- Updated dependencies [3b763e9]
  - @pulse/db@0.12.0

## 0.14.0

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
  - @pulse/db@0.11.0

## 0.13.0

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

### Patch Changes

- Updated dependencies [9de67a2]
  - @pulse/db@0.10.0
  - @shared/observability@0.9.0
  - @shared/crypto@0.6.9

## 0.12.2

### Patch Changes

- Updated dependencies [ac7312b]
  - @shared/observability@0.8.1
  - @shared/crypto@0.6.8

## 0.12.1

### Patch Changes

- b57f0f6: Allow `pulse-api` to boot in local dev when `INTERNAL_SERVICE_SECRET` is unset. Registration is skipped with a warning log; S2S calls to `osn/api` will fail until the secret is configured. Non-local environments (`OSN_ENV != "local"`) still throw on startup as before.

## 0.12.0

### Minor Changes

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

### Patch Changes

- 31957b4: Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @pulse/db@0.9.2
  - @shared/crypto@0.6.7
  - @zap/db@0.3.1
  - @shared/observability@0.8.0

## 0.11.10

### Patch Changes

- Updated dependencies [6387b98]
  - @shared/observability@0.7.0
  - @shared/crypto@0.6.6

## 0.11.9

### Patch Changes

- Updated dependencies [b1d5980]
  - @shared/observability@0.6.1
  - @shared/crypto@0.6.5

## 0.11.8

### Patch Changes

- Updated dependencies [c04163d]
  - @shared/observability@0.6.0
  - @shared/crypto@0.6.4

## 0.11.7

### Patch Changes

- Updated dependencies [811eda4]
  - @shared/observability@0.5.2
  - @shared/crypto@0.6.3

## 0.11.6

### Patch Changes

- Updated dependencies [58e3e12]
  - @shared/observability@0.5.1
  - @shared/crypto@0.6.2

## 0.11.5

### Patch Changes

- Updated dependencies [dc8c384]
  - @shared/observability@0.5.0
  - @shared/crypto@0.6.1

## 0.11.4

### Patch Changes

- Updated dependencies [9459f5e]
  - @shared/crypto@0.6.0
  - @shared/observability@0.4.0

## 0.11.3

### Patch Changes

- Updated dependencies [2d5cce9]
  - @shared/observability@0.3.3
  - @shared/crypto@0.5.3

## 0.11.2

### Patch Changes

- Updated dependencies [2a7eb82]
  - @shared/observability@0.3.2
  - @shared/crypto@0.5.2

## 0.11.1

### Patch Changes

- @shared/crypto@0.5.1

## 0.11.0

### Minor Changes

- 0edef32: Switch OSN access token signing from HS256 to ES256 and expose a JWKS endpoint.

  - `@shared/crypto`: add `thumbprintKid(publicKey)` helper (RFC 7638 SHA-256 thumbprint)
  - `@shared/observability`: add `JwksCacheResult` metric attribute type
  - `@osn/api`: replace `AuthConfig.jwtSecret` with `jwtPrivateKey`, `jwtPublicKey`, `jwtKid`, `jwtPublicKeyJwk`; add `GET /.well-known/jwks.json`; update OIDC discovery with `jwks_uri`; ephemeral key pair in local dev when env vars are unset
  - `@pulse/api`: replace symmetric JWT verification with JWKS-backed ES256 verification; add in-process JWKS key cache with 5-minute TTL and rotation-aware refresh; remove `OSN_JWT_SECRET` dependency

### Patch Changes

- Updated dependencies [0edef32]
  - @shared/crypto@0.5.0
  - @shared/observability@0.3.1

## 0.10.2

### Patch Changes

- Updated dependencies [1f14c6a]
  - @shared/crypto@0.4.1

## 0.10.1

### Patch Changes

- 177eeea: Merge `@osn/core` into `@osn/api` and move `@osn/crypto` to `@shared/crypto`.

  - `@osn/api` now owns all auth, graph, org, profile, and recommendations routes and services directly — no longer delegates to `@osn/core`
  - `@shared/crypto` is the new home for ARC token crypto (was `@osn/crypto`); available to all workspace packages
  - ARC audience claim updated from `"osn-core"` to `"osn-api"` for consistency with the merged service identity
  - `@pulse/api` updated to import from `@shared/crypto` and target `aud: "osn-api"` on outbound ARC tokens

- Updated dependencies [177eeea]
  - @shared/crypto@0.4.0

## 0.10.0

### Minor Changes

- fe55da8: Implement kid-based ARC key auto-rotation. Adds service_account_keys table (per-key rows, zero-downtime rotation). ArcTokenClaims now requires a kid field (JWT header). resolvePublicKey now takes (kid, issuer, scopes). pulse/api auto-rotates ephemeral keys via startKeyRotation(). Migrates pulse/api graph bridge from in-process imports to ARC-token authenticated HTTP calls against /graph/internal/\* endpoints.

### Patch Changes

- Updated dependencies [fe55da8]
  - @osn/crypto@0.3.0

## 0.9.10

### Patch Changes

- Updated dependencies [f594a46]
  - @osn/core@0.17.2

## 0.9.9

### Patch Changes

- Updated dependencies [1d9be5a]
  - @osn/core@0.17.1

## 0.9.8

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/core@0.17.0

## 0.9.7

### Patch Changes

- Updated dependencies [d691034]
  - @osn/core@0.16.4

## 0.9.6

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @shared/observability@0.3.0
  - @osn/core@0.16.3

## 0.9.5

### Patch Changes

- Updated dependencies [42589e2]
  - @shared/observability@0.2.10
  - @osn/core@0.16.2

## 0.9.4

### Patch Changes

- Updated dependencies [a723923]
  - @osn/core@0.16.1
  - @osn/db@0.7.2
  - @shared/observability@0.2.9

## 0.9.3

### Patch Changes

- Updated dependencies [8137051]
  - @osn/core@0.16.0
  - @shared/observability@0.2.8

## 0.9.2

### Patch Changes

- Updated dependencies [33e6513]
  - @osn/core@0.15.0
  - @shared/observability@0.2.7

## 0.9.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.
- Updated dependencies [5520d90]
  - @osn/db@0.7.1
  - @osn/core@0.14.1
  - @pulse/db@0.9.1

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

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/db@0.7.0
  - @osn/core@0.14.0
  - @pulse/db@0.9.0
  - @zap/db@0.3.0
  - @shared/observability@0.2.6

## 0.8.2

### Patch Changes

- Updated dependencies [e2ef57b]
  - @osn/db@0.6.0
  - @osn/core@0.13.0
  - @shared/observability@0.2.5

## 0.8.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/core@0.12.1
  - @osn/db@0.5.3
  - @pulse/db@0.8.1
  - @shared/observability@0.2.4
  - @zap/db@0.2.1

## 0.8.0

### Minor Changes

- 7349512: Add Zap messaging backend with chat and message services for event chat integration

  - Create `@zap/db` package with chats, chat_members, and messages schema (Drizzle + SQLite)
  - Create `@zap/api` package with Elysia server (port 3002), chat/message REST routes, Effect services, and observability metrics
  - Add `chatId` column to Pulse events schema for event-chat linking
  - Add `zapBridge` service in Pulse for provisioning event chats and managing membership

### Patch Changes

- Updated dependencies [7349512]
  - @zap/db@0.2.0
  - @pulse/db@0.8.0

## 0.7.6

### Patch Changes

- Updated dependencies [b48d68e]
  - @osn/core@0.12.0

## 0.7.5

### Patch Changes

- Updated dependencies [19c39ba]
  - @osn/core@0.11.0

## 0.7.4

### Patch Changes

- Updated dependencies [77ce7ad]
  - @osn/core@0.10.0

## 0.7.3

### Patch Changes

- e8b4f93: Add close friends to the OSN graph properly

  - Add `isCloseFriendOf` and `getCloseFriendsOfBatch` helpers to the graph service
  - Add `GET /graph/close-friends/:handle` status check endpoint
  - Instrument close friend operations with metrics (`osn.graph.close_friend.operations`) and tracing spans
  - Fix `removeConnection` to clean up close-friend entries in both directions (consistency bug)
  - Transaction-wrap `removeConnection` and `blockUser` multi-step mutations
  - Add `close_friends_friend_idx` index on `friend_id` for reverse lookups
  - Clamp `getCloseFriendsOfBatch` input to 1000 items (SQLite variable limit)
  - Sanitize error objects in graph operation log annotations
  - Migrate Pulse graph bridge from raw SQL to service-level `getCloseFriendsOfBatch`
  - Add `GraphCloseFriendAction` attribute type to shared observability

- Updated dependencies [e8b4f93]
  - @osn/core@0.9.0
  - @osn/db@0.5.2
  - @shared/observability@0.2.3

## 0.7.2

### Patch Changes

- f87d7d2: Auth security hardening: per-IP rate limiting on all auth endpoints (S-H1), redirect URI allowlist validation (S-H3), mandatory PKCE at /token (S-H4), legacy unauth'd passkey path removed (S-H5), login OTP attempt limit + unbiased generation + timing-safe comparison (S-M7/M24/M25), dev-log NODE_ENV gating (S-M22), console.\* replaced with Effect.logError. Oxlint no-new warning fixed in @pulse/api. AuthRateLimitedEndpoint type added to @shared/observability.
- Updated dependencies [f87d7d2]
  - @osn/core@0.8.0
  - @shared/observability@0.2.2

## 0.7.1

### Patch Changes

- Updated dependencies [1cc3aa5]
  - @osn/core@0.7.0
  - @shared/observability@0.2.1

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

### Patch Changes

- Updated dependencies [ebaf56a]
  - @pulse/db@0.7.0

## 0.6.0

### Minor Changes

- cab97ca: Scaffold `@shared/observability` — OSN's single source of truth for logs,
  metrics, and tracing.

  **New package `@shared/observability`** exports:

  - `initObservability(overrides)` — one-shot bootstrap that loads config
    from env vars (`OSN_SERVICE_NAME`, `OSN_ENV`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
    …) and returns a combined Effect Layer wiring up the logger, OTel tracer,
    and metric exporter.
  - **Logger** — Effect `Logger.jsonLogger` in prod, `Logger.prettyLogger()` in
    dev, both wrapped with a deny-list redaction pass that scrubs ~30 known
    secret-bearing keys (`password`, `email`, `token`, `ciphertext`, `ratchetKey`,
    …) from log annotations and errors before serialization. Add new keys to
    `src/logger/redact.ts`; never remove.
  - **Metrics factory** — typed `createCounter<Attrs>`, `createHistogram<Attrs>`,
    `createUpDownCounter<Attrs>`. The `<Attrs>` generic pins allowed attribute
    keys at declaration so TypeScript rejects unbounded values (userId,
    requestId, …) at compile time. Standard latency buckets
    (`LATENCY_BUCKETS_SECONDS`) and byte buckets (`BYTE_BUCKETS`) exported
    for consistency.
  - **HTTP RED metrics** — `http.server.requests`, `http.server.request.duration`,
    `http.server.active_requests` following OTel semantic conventions. Emitted
    automatically by the Elysia plugin; handlers never call these directly.
  - **Tracing layer** — `@effect/opentelemetry` NodeSdk with OTLP trace +
    metric exporters, parent-based trace-id-ratio sampler (1.0 in dev, 0.1
    in prod by default, overridable via `OSN_TRACE_SAMPLE_RATIO`).
  - **W3C propagation helpers** — `injectTraceContext(headers)` and
    `extractTraceContext(headers)` so outbound fetches participate in the
    same trace.
  - **`instrumentedFetch`** — drop-in replacement for `globalThis.fetch` that
    creates a client span, injects `traceparent`, and records status/errors.
    Use for all S2S HTTP calls.
  - **Elysia plugin** `observabilityPlugin({ serviceName })` — wires up per-
    request spans, request ID propagation (`x-request-id`), OTel HTTP semconv
    attributes, and RED metric emission via `onRequest` / `onAfterHandle` /
    `onError` / `onAfterResponse` hooks.
  - **Health routes** — `/health` (liveness; always 200 if the process is up)
    and `/ready` (readiness; takes an optional `probe` function that runs a
    trivial dep check like `SELECT 1`).

  **Metrics conventions** (see `CLAUDE.md` "Observability" section for the
  full rules):

  - Naming: `{namespace}.{domain}.{subject}.{measurement}` (e.g.
    `pulse.events.created`, `osn.auth.login.attempts`, `arc.token.issued`).
  - Every metric declared exactly once in a co-located `metrics.ts` file
    (`pulse/api/src/metrics.ts`, `osn/crypto/src/arc-metrics.ts`, …) via
    typed helpers — raw OTel meter calls are banned.
  - Default resource attributes (`service.name`, `service.namespace`,
    `service.version`, `service.instance.id`, `deployment.environment`) are
    applied automatically by the SDK init; never set per-metric.
  - Per-metric attribute values must be bounded string-literal unions
    (`"ok" | "error" | "rate_limited"`), never `string`.

  **Wired into `@pulse/api`**:

  - Elysia plugin and health routes active in `src/index.ts`.
  - `src/metrics.ts` defines Pulse domain metrics (`pulse.events.created`,
    `pulse.events.updated`, `pulse.events.deleted`, `pulse.events.listed`,
    `pulse.events.create.duration`, `pulse.events.status_transitions`,
    `pulse.events.validation.failures`) via typed counters.
  - `src/services/events.ts` is instrumented: every service function is
    wrapped in `Effect.withSpan("events.<op>")`, and domain counters fire
    on success/error paths.

  **Wired into `@osn/crypto`**:

  - New `src/arc-metrics.ts` with typed ARC counters (`arc.token.issued`,
    `arc.token.verification`, `arc.token.cache.hits`/`misses`,
    `arc.token.public_key.cache.hits`/`misses`).
  - `createArcToken`, `verifyArcToken`, `getOrCreateArcToken`, and
    `resolvePublicKey` now emit metrics on the happy path and classify
    verification failures into the bounded `ArcVerifyResult` union
    (`ok | expired | bad_signature | unknown_issuer | scope_denied |
audience_mismatch | malformed`).

  **Out of scope for this PR** (deliberately): wiring into `@osn/app` and
  `@osn/core` (tracked as follow-ups), WebSocket instrumentation, dashboards
  and alert rules, migration of stray `console.*` calls in auth routes
  (tracked separately as S-L8).

  30 new tests across redaction, config parsing, trace propagation, health
  routes, and the metrics factory. Full monorepo test suite passes (390+
  tests).

### Patch Changes

- Updated dependencies [cab97ca]
- Updated dependencies [cab97ca]
  - @osn/core@0.6.0
  - @shared/observability@0.2.0

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
  - @pulse/db@0.6.0

## 0.4.4

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
  - @pulse/db@0.5.1

## 0.4.3

### Patch Changes

- d8e3559: Reject event creation when `startTime` is not strictly in the future. The events service now returns a `ValidationError` (HTTP 422) if the supplied `startTime` is at or before the current moment, preventing past-dated events from being created.

## 0.4.2

### Patch Changes

- Updated dependencies [45248b2]
  - @pulse/db@0.5.0

## 0.4.1

### Patch Changes

- 9caa8c7: Add user handle system

  Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

  - **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
  - **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
  - **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
  - **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility

## 0.4.0

### Minor Changes

- 05a9022: Add event ownership enforcement: `createdByUserId NOT NULL` on events, auth required for POST/PATCH/DELETE, ownership check (403) on mutating operations, `createdByName` derived server-side from JWT email claim, index on `created_by_user_id`, `updateEvent` eliminates extra DB round-trip.

### Patch Changes

- Updated dependencies [05a9022]
  - @pulse/db@0.4.0

## 0.3.0

### Minor Changes

- 89b104c: Add latitude/longitude columns to the events schema, store geocoordinates from Photon autocomplete in the create form, and display an "Open in Maps" link on each EventCard using coordinates when available or text-based search as a fallback.

### Patch Changes

- Updated dependencies [89b104c]
  - @pulse/db@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [caafe67]
  - @pulse/db@0.2.1

## 0.2.2

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

## 0.2.1

### Patch Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

## 0.2.0

### Minor Changes

- 880e762: Split `packages/db` into `packages/osn-db` (`@osn/db`) and `packages/pulse-db` (`@pulse/db`). Each app now owns its database layer: OSN Core owns user/session/passkey schema, Pulse owns events schema. Replace Valibot with Effect Schema in the events service — `effect/Schema` is used for service-layer domain validation and transforms (e.g. ISO string → Date), while Elysia TypeBox remains at the HTTP boundary for route validation and Eden type inference.

### Patch Changes

- Updated dependencies [880e762]
- Updated dependencies [880e762]
  - @pulse/db@0.2.0

## 0.1.1

### Patch Changes

- 51abbcc: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.
- Updated dependencies [51abbcc]
  - @osn/db@0.1.1

## 0.1.0

### Minor Changes

- efcf464: Apply auto transition for event lifecycle
- 96c406d: Added testing framework

### Patch Changes

- Updated dependencies [96c406d]
  - @osn/db@0.1.0
