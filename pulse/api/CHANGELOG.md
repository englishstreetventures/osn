# @osn/api

## 0.23.0

### Minor Changes

- 5055e1a: Harden the Pulse API write + share surface (W4):

  - **Per-user write rate limiting** on every authenticated write endpoint —
    event create (20/5min), update (60/min), RSVP (30/min), bulk invite (10/min),
    comms blast (5/min), series create (10/hr) + patch (60/hr), and close-friend
    mutations (60/min). Keyed on `claims.profileId` (not IP) and fail-closed: a
    backend error is treated as rate-limited. Rejections record the new
    `pulse.write.rate_limited` counter.
  - **Redis composition root** (`src/redis.ts` + `src/lib/redis-rate-limiters.ts`)
    mirroring osn/api: Redis-backed limiters when `REDIS_URL` is set, in-memory
    fallback for local/test. Same env-driven selection + fail-closed-on-required
    behaviour. Covers the per-user write limiters plus the per-IP discover /
    share / exposure limiters.
  - **CORS allowlist** replaces the bare `cors()` wildcard. Origins come from
    `PULSE_CORS_ORIGIN`; non-local envs fail closed if it is unset, local dev
    falls back to the Tauri dev port (1420).
  - **Hardened per-IP limiting on the share-attribution surface**
    (`POST /events/:id/share` + `/exposure`) and `/events/discover`: the keying
    IP is now resolved via the spoofing-resistant `getClientIp(headers, options)`
    trust policy (`PULSE_TRUSTED_PROXY_COUNT`, or `trustCloudflare` behind CF).
    An unresolved IP fails closed (429) instead of sharing a single `unknown`
    bucket. (An HMAC-signed share token to bind the share/exposure ping to a
    real share event remains a deferred follow-up.)
  - **Attendee visibility flag**: a new `canViewAttendees` policy
    (`services/eventAccess.ts`) is surfaced as an additive, non-breaking boolean
    on the `GET /events/:id/rsvps` and `/rsvps/latest` responses (organiser-only
    today; the organiser-only payload cutover is deferred).

  Minor (not patch): the additive `canViewAttendees` response field is a new
  wire surface that Eden-treaty clients pick up.

### Patch Changes

- aed9d98: Add a Workers-compatible Upstash REST Redis backend (migration Phase 2).

  `@shared/redis` now ships three interchangeable `RedisClient` backends behind
  the same interface, split so the Workers bundle never statically imports
  `ioredis` (which needs Node `net`/`tls` sockets and cannot run on workerd):

  - **ioredis split to a subpath.** `wrapIoRedis`, `createClientFromUrl`,
    `ConnectableRedisClient`, and the Effect `RedisLive` layer moved to a new
    `@shared/redis/ioredis` subpath export. The top-level `@shared/redis` entry
    now exports only the `RedisClient` interface, the in-memory client, and the
    new Upstash client — no static `ioredis` import in its graph.
  - **Upstash adapter.** New `@shared/redis/upstash` with `wrapUpstash(redis)`
    and `createUpstashClient({ url, token })`. `createUpstashClient` sets
    `automaticDeserialization: false` so `get` returns raw strings (matching
    ioredis and the rotated-session-store's opaque family-id round-trips); `set`
    maps `pxMs` to `{ px }`; `eval` passes the script/keys/args straight through
    (preserving numeric returns for the rate-limit Lua and the `1`/`"1"` step-up
    jti check); `quit` is a no-op for the stateless REST transport.

  `@osn/api` gains `initRedisClientFromEnv(env)` — a synchronous, ioredis-free,
  side-effect-free selector that returns `createUpstashClient(...)` when both
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are present on the
  Workers `env` binding, else an in-memory client. It performs no startup health
  check, has no `REDIS_REQUIRED` fail-closed mode, and never calls
  `process.exit` — those stay on the Bun `initRedisClient` path, which is
  unchanged. Consumers (rate limiters, rotated-session/step-up/ceremony stores)
  remain backend-agnostic; no call sites changed.

- 5055e1a: Harden shared crypto / auth-client issuer handling (W7).

  - `@shared/crypto` `verifyArcToken` gains an optional `expectedIssuer` argument
    (X1). When set, jose enforces the signed `iss`, cryptographically binding the
    token issuer to the `kid`→issuer DB mapping. The OSN ARC middleware now passes
    the peeked issuer so a token whose `iss` differs from its `kid`'s registered
    service is rejected at verification time. Pulse's in-memory ARC receiver
    passes the registered issuer too (its explicit post-verify `iss` check is kept
    as defence-in-depth). Backward compatible — omitting the argument leaves `iss`
    unenforced.
  - ARC token cache key now includes the requested `ttl` and a canonicalised
    scope (X3), so a token requested with a shorter TTL never reuses a
    longer-lived cached entry and formatting-only scope differences collapse onto
    one entry. Scope is not sorted (differing scope order stays distinct, matching
    the signed claim).
  - The ARC public-key cache TTL is now overridable via
    `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS` (default 300), bounding the cross-process
    key-revocation window (X4).
  - `@shared/osn-auth-client` `extractClaims` / `osnAuth` adapters gain an optional
    `issuer` option and apply a 30s `clockTolerance` (X2). Issuer is optional and
    unset by default for rollout safety — when unset, `iss` is not enforced so
    pre-issuer-stamping access tokens still verify. An issuer mismatch is terminal
    (no JWKS refetch).
  - `@shared/redis` in-memory client `eval` now asserts it is only ever handed the
    rate-limit Lua script (X5), so a future, semantically-different script cannot
    silently inherit fixed-window rate-limit behaviour.

- Updated dependencies [5055e1a]
- Updated dependencies [dbed689]
- Updated dependencies [5aa1594]
- Updated dependencies [aed9d98]
- Updated dependencies [130e6c5]
- Updated dependencies [5055e1a]
- Updated dependencies [5e4c560]
- Updated dependencies [5055e1a]
  - @shared/redis@0.4.0
  - @shared/observability@0.11.0
  - @shared/rate-limit@0.3.0
  - @shared/db-utils@0.3.1
  - @shared/osn-auth-client@0.2.0
  - @shared/crypto@0.8.0
  - @pulse/db@0.18.1
  - @zap/db@0.4.1

## 0.22.0

### Minor Changes

- f466a65: Migrate Pulse and the OSN core DB layer onto the four-environment database story
  (local bun:sqlite / dev·staging·prod D1). D1 has no interactive transaction, so
  every `db.transaction(async tx => …)` is rewritten to the shared `commitBatch`
  helper — an atomic `db.batch([...])` on D1, sequential awaited writes on
  bun:sqlite — preserving all-or-nothing semantics on the deployed driver.

  `@pulse/api`: 5 account-erasure transactions → `commitBatch`; `createApp`
  factory (`aot: false`) + `local.ts` (Bun.serve) + Workers `index.ts` (D1) +
  `wrangler.toml` (dev/staging/production) + a Miniflare integration test.

  `@osn/api`: all 17 transactions across auth / profile / graph / organisation /
  account-erasure → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants
  (UNIQUE-constraint guards for handle/email races; a count-guarded conditional
  DELETE for the last-passkey invariant). Adds a Miniflare integration test and a
  `wrangler.toml` for D1 migration tooling. NOTE: full Workers _hosting_ of
  osn-api remains gated on replacing ioredis with a Workers-compatible Redis —
  its DB layer is D1-ready but it still runs only as the Bun.serve `local` host.

  `@pulse/db` / `@osn/db`: broadened service `Db` type + `makeDbD1Live`,
  schema-reflection `./testing` export, and wrangler-based `db:migrate:*` scripts.

### Patch Changes

- Updated dependencies [f466a65]
- Updated dependencies [f466a65]
  - @shared/db-utils@0.3.0
  - @zap/db@0.4.0
  - @pulse/db@0.18.0
  - @shared/crypto@0.7.1
  - @shared/osn-auth-client@0.1.3

## 0.21.1

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

- Updated dependencies [d04dc20]
- Updated dependencies [77f91a4]
- Updated dependencies [04e0bf2]
- Updated dependencies [940561f]
  - @shared/crypto@0.7.0
  - @shared/observability@0.10.1
  - @pulse/db@0.17.1
  - @zap/db@0.3.2
  - @shared/osn-auth-client@0.1.2
  - @shared/rate-limit@0.2.2

## 0.21.0

### Minor Changes

- c3cca40: Account deletion compliance (C-H2 / GDPR Art. 17).

  Two flows:

  - **Flow A — full OSN account delete.** New `DELETE /account` on osn-api with step-up gate, 7-day soft-delete grace + manual fast-track, ARC fan-out to currently-enrolled apps, hard-delete sweeper.
  - **Flow B — leave Pulse.** New `DELETE /account` on pulse-api with step-up verification round-trip to osn-api. Hosted events flip into a 14-day public cancellation window before hard-delete (audience commitment, independent of the 7-day account grace).

  Schema additions:

  - `osn/db`: `accounts.deleted_at`, `accounts.processing_restricted_at`, new `app_enrollments` (modular-platform opt-in tracking) and `deletion_jobs` (in-flight tombstones with per-bridge `*_done_at`).
  - `pulse/db`: `events.cancelled_at` / `hard_delete_at` / `cancellation_reason`, new `pulse_deletion_jobs`.

  Other surfaces:

  - New step-up token `purpose` claim (`account_delete`, `pulse_app_delete`) — confused-deputy guard for cross-service flows.
  - New osn-api internal endpoints: `/internal/step-up/verify`, `/internal/app-enrollment/{join,leave}`. ARC scopes `step-up:verify`, `app-enrollment:write`, `account:erase` added to the register-service allowlist.
  - Pulse becomes an ARC verifier (in-memory key registry + `/internal/register-service`) and an ARC issuer for the leave-app callback.
  - New observability: `osn.account.deletion.{requested,completed,duration,fanout,fanout_pending_age}`, `osn.account.app_enrollment.{joined,left}`, `pulse.account.deletion.*`, `pulse.events.host_cancelled[.hard_delete]`.
  - New `osn/client` SDK methods: `deleteAccount`, `cancelAccountDeletion`, `getAccountDeletionStatus`.

### Patch Changes

- Updated dependencies [c3cca40]
  - @pulse/db@0.17.0
  - @shared/observability@0.10.0
  - @shared/crypto@0.6.12
  - @shared/osn-auth-client@0.1.1

## 0.20.0

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
  - @pulse/db@0.16.0

## 0.19.0

### Minor Changes

- 34a912f: Pulse calendar page: a vertical-timeline agenda (`/calendar`) listing the events you're hosting or have RSVP'd Going / Maybe to, grouped by day with a continuous timeline axis on the left. Maybe RSVPs surface an inline reminder to confirm (I'm going) or drop (Can't make it). Backed by a new auth-gated `GET /events/calendar` endpoint + `listMyCalendarEvents` service (instrumented with the `pulse.calendar.events.fetched` metric and a `pulse.calendar.list_mine` span). The Calendar tab in the Explore nav now routes here.

  Also renames the RSVP "interested" status to "maybe" end-to-end (DB enum value, API wire value, metrics, and UI) — no legacy alias, as nothing is deployed yet. The per-event `allowInterested` toggle column keeps its name.

### Patch Changes

- Updated dependencies [34a912f]
  - @pulse/db@0.15.0

## 0.18.0

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
  - @pulse/db@0.14.0

## 0.17.1

### Patch Changes

- 1a4e9d5: Harden the shared OSN access-token verifier: treat expired/invalid
  tokens as terminal (no JWKS refetch), negative-cache unknown kids,
  coalesce concurrent JWKS fetches, and add a fetch timeout — removing a
  per-request upstream-fetch amplifier on every consumer. Fold the
  audience check into the single jwtVerify pass. Pulse routes now enforce
  aud=osn-access (previously any OSN-issued token authenticated).
- 051daa8: Extract OSN access-token verification + JWKS cache into a new shared
  package, `@shared/osn-auth-client`, with per-framework middleware
  adapters (Hono + Elysia). Pulse switches to consuming the shared
  verifier; cire will follow in a later phase.
- Updated dependencies [9f6874b]
- Updated dependencies [1a4e9d5]
- Updated dependencies [051daa8]
  - @shared/observability@0.9.2
  - @shared/osn-auth-client@0.1.0
  - @shared/crypto@0.6.11

## 0.17.0

### Minor Changes

- dd742dd: Pulse first-run onboarding: six-step `/welcome` flow with themed coral illustrations (welcome rings, editorial map, interest constellation, location pin drop, notifications ember, finish date stamp). Captures interests, location/notifications permissions, and reminder opt-in. Account-keyed server-side via a new `pulse_account_onboarding` table + `pulse_profile_accounts` mapping cache + new `GET /graph/internal/profile-account` ARC endpoint on `osn/api` — preserves the multi-account privacy invariant (accountId never on the wire). Server-side first-run gate redirects new users to `/welcome` and is idempotent on the completion POST. See `wiki/systems/pulse-onboarding.md`.

### Patch Changes

- Updated dependencies [dd742dd]
  - @pulse/db@0.13.0

## 0.16.1

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
  - @pulse/db@0.12.3
  - @shared/observability@0.9.1
  - @shared/crypto@0.6.10

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
