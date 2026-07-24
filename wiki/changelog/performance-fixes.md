---
title: Performance Fixes — Completed
tags: [changelog, performance]
related:
  - "[[TODO]]"
  - "[[redis]]"
  - "[[arc-tokens]]"
  - "[[component-library]]"
last-reviewed: 2026-07-24
---

# Performance Fixes — Completed

Archived completed performance findings from [[TODO]]. Finding IDs follow the [[review-findings]] format. For open findings see the Performance Backlog in [[TODO]].

## OIDC provider P-W batch (2026-07-24)

The micro-optimisation batch deferred out of PR #315, plus the two [x] rows archived from the backlog.

- **P-C1 / S-L2 (oidc)** — _fixed in PR #315 itself, archived here._ Expired `oauth_authorization_codes` were never purged; `runExpiredAuthCodeSweep` (`lte(expiresAt, now)` batch delete riding `oauth_codes_expires_idx`) runs as a third `ctx.waitUntil` in the Worker's `scheduled` handler.
- **P-W1 (oidc)** — `/token` re-read the client row purely to label the success counter. `exchangeAuthorizationCode` now returns `{ response, isFirstParty }`, so the route emits the metric from data the exchange already held — one D1 read saved per successful exchange.
- **P-W2 (oidc)** — same shape on the decision path: the route pre-read the parked request **and** the client before calling `completeAuthorization` (which read both again) just to label the consent-granted metric. `DecisionResult` now carries `isFirstParty`; the pre-reads are gone — one ceremony-store `get` + one D1 read saved per decision.
- **P-W3 (oidc)** — **declined, documented.** The `/token` reads are dependency-ordered, not independent: consuming the code before client authentication succeeds would burn a victim's code on an attacker's failed auth attempt (today a failed `invalid_client` leaves the code redeemable by the real client), and the profile read needs the consumed row's `profileId`. Parallelising would trade a correctness property for ~one round-trip on a low-QPS endpoint. Not re-raising.
- **P-W4 (oidc)** — `recordConsent` is now insert-first: a single `INSERT … ON CONFLICT DO NOTHING … RETURNING` serves the first-link path in one statement; only re-consent pays the read-merge-write (a scope UNION cannot be expressed in a conflict clause). The unique-index race the finding described is gone for new links.
- **P-W5 (oidc)** — the ID-token + access-token signatures run concurrently under `Effect.all({ concurrency: 2 })`; the key was already resident, so the win is the serial await, not a key load.
- **P-I3 (oidc)** — `findClient` / `findConsent` (and the new `listConsents`) use explicit column projections instead of `SELECT *`.
- **P-I2 (oidc)** stays open-by-design in the backlog (forward-looking sector index, documented so it isn't re-flagged).

## Code-quality review sweep (2026-07-03)

- **P-W (pulse/zap per-request layer rebuild)** — **Issue:** every route handler in `pulse/api` (8 factories, 48 call sites across events/venues/series/closeFriends/account/onboarding/internal) and `zap/api` (`chats.ts`, 9 call sites) ran `Effect.runPromise(eff.pipe(Effect.provide(dbLayer)))`, rebuilding the layer graph — for the default `DbLive`, a fresh never-closed `bun:sqlite` connection — on **every request**, the exact anti-pattern documented in [[backend-patterns]] and already fixed in `osn/api` (#118). **Why:** per-request resource-graph construction scales cost with traffic instead of boot count and leaks connections. **Solution:** each factory now builds `ManagedRuntime.make(dbLayer)` once at construction; handlers call `runtime.runPromise(eff)`. Test injection seams unchanged (tests pass their layer to the factory as before). Dead pre-instantiated route-group exports (`eventsRoutes`, `venuesRoutes`, … 9 total), which would have eagerly built runtimes at import, were removed. **Rationale:** brings pulse/zap onto the same one-time-boot-cost contract as `osn/api`; full pulse (512) + zap (101) suites green. See [[backend-patterns]].

## Performance audit sweep (2026-07-03)

Cross-monorepo sweep of the open Performance Backlog. All fixes preserve security semantics exactly (fail-closed rate limiting, visibility gates, consent checks, single-use guarantees, tenant scoping); two of them (P-I2 recovery, P-W2 series) also close check-then-act races as a side effect.

### zap/api

- **P-W1 (zap)** — `listChats` returned every chat a profile belongs to, unbounded. **Fixed:** cursor pagination (default 50, max 100) over a single membership-joined query; cursor contract mirrors the hardened `listMessages` one (caller-scoped lookup, unknown/foreign cursors rejected with `ValidationError` → 422). Review round: cursor is a composite `(createdAt, id)` keyset ordered `createdAt DESC, id DESC` — `created_at` has second resolution, so a bare `createdAt <` would silently skip same-second chats (P-W2 in the prep-pr review) — and the response carries `hasMore`/`nextCursor` via a limit+1 fetch (P-I4). See [[zap]].
- **P-W2 (zap)** — `addMember` fetched all members to check the 500-member cap. **Fixed:** `SELECT COUNT(*)` for the cap and a `LIMIT 1` lookup on the unique `(chat_id, profile_id)` pair for the duplicate check; authz + fail-closed consent order unchanged. See [[zap]].
- **P-W4 (zap)** — `getChatMembers` returned all members unbounded. **Fixed:** limit/offset pagination (default 100, max 500) with deterministic `joinedAt ASC, id ASC` ordering. Review round: response carries `hasMore` (limit+1 fetch, P-I4), and the internal existence load is skipped when the route has already gated on `assertMember` (P-I5 — the membership row FK-proves the chat exists). See [[zap]].

### osn/api

- **P-W4 / P-W1 (cdl)** — The legacy `otpStore`/`magicStore` maps are gone (superseded by `createInMemoryCeremonyStore` with passkey-primary), but the successor store still ran a full O(n) TTL scan on **every** `set` — the same pathology both findings tracked. **Fixed:** sweep debounced to at most once per 30 s (mirroring `maybeSweepExpiredTokens` in `@shared/crypto`); lazy expiry on `get` unchanged; the `CEREMONY_STORE_MAX` hard cap is still enforced on every set (expired-first sweep, FIFO drop as last resort). See [[sessions]].
- **P-W11** — `beginRegistration` (and `registerProfile`, same pattern) issued two parallel uniqueness queries. **Fixed (revised in the prep-pr review):** the first cut collapsed them into `WHERE email = ? OR handle = ?` across the users⋈accounts join, which defeats SQLite's OR-optimization and plans as a full `users` scan (P-W1 in the review — verified with `EXPLAIN QUERY PLAN`). Final form: one round-trip `UNION ALL` of two single-table arms, each a covering-index seek on its UNIQUE column. Identical error responses and S-M1 enumeration behaviour preserved. See [[identity-model]].
- **P-W3** — `sendConnectionRequest` ran its two independent reads (block check, existing-connection check) sequentially. **Fixed:** `Effect.all` with unbounded concurrency; blocked-first failure priority preserved. See [[social-graph]].
- **P-I5b** — Adapted (literal finding stale — no `findProfileByEmail` remains): the `accounts`-row SELECT that `completePasskeyLogin` executed on both flows is only needed for the discoverable flow's `userHandle` pin. **Fixed:** moved into the discoverable branch; identified-flow existence is proven by `resolveIdentifier`'s join + accountId binding. All verification checks intact. See [[passkey-primary]].
- **P-I1 (recovery)** — `countActiveRecoveryCodes` fetched full rows (including `code_hash`) to count in JS. **Fixed:** single `SUM(CASE WHEN used_at IS NULL …)/COUNT(*)` aggregate; no secret-bearing columns fetched. See [[recovery-codes]].
- **P-I2 (recovery)** — `consumeRecoveryCode` was SELECT + separate CAS transaction. **Fixed:** one atomic `UPDATE … WHERE account_id = ? AND code_hash = ? AND used_at IS NULL RETURNING id` — removes the remaining check-then-act window on every backend. Per-account lockout ordering, failed-attempt counting, audit events, metric classification, and the generic error shape all preserved. See [[recovery-codes]].
- **P-I2/P-I3 (TextEncoder)** — Only one per-call `new TextEncoder()` existed (`beginPasskeyRegistration`); hoisted to module scope. JWT sign/verify uses jose `CryptoKey`s directly and `verifyPkceChallenge` was removed with Phase 5b — both sides verified stale.
- **P-I1 (auth)** — `logDevOtp` re-read `process.env.OSN_ENV` per OTP issuance. **Fixed:** resolved once and cached — lazily on first call rather than at module evaluation (S-L2 in the prep-pr security review: an env populated after module load could otherwise freeze an unset `OSN_ENV` into "local", and with it dev-OTP logging, for the process lifetime).
- **P-I9** — Verified already fixed: graph list endpoints all push `LIMIT`/`OFFSET` into the DB query; no JS slicing remains. Closed as stale.
- **P-I8** — Verified stale: every `resolveHandle` call site resolves a *target* handle from URL params; no handler already holds that row. Closed.

### pulse/api + pulse/db

- **P-W3 (pulse)** — `listTodayEvents` had no `LIMIT`. **Fixed:** `TODAY_EVENTS_LIMIT = 200` cap (route exposes no limit param), matching the `listRsvps`/`listVenueEvents` ceiling. See [[event-access]].
- **P-W5 + P-W1 (series)** — Status transitions were persisted one `UPDATE` per row across all list surfaces (up to 500 writes per GET on `listInstances`). **Fixed:** shared `applyTransitions(rows)` groups persisted transitions by (from → to) and issues one `UPDATE … WHERE id IN (…)` per group, covering `listEvents`, `listTodayEvents`, `listMyCalendarEvents`, `listVenueEvents`, and `listInstances`. Exact semantics preserved: terminal statuses sticky, `maybe_finished` display-only, `updatedAt` stamped, same span/counter (counter now `add(count)` per group). See [[venues]], [[event-access]].
- **P-W2 (series)** — `updateSeries` SELECT-then-UPDATE raced an `instanceOverride` flip and cost extra round-trips. **Fixed:** single `UPDATE … WHERE seriesId ∧ NOT override ∧ startTime ≥ cutoff RETURNING id` — override predicate evaluated atomically at write time.
- **P-W3 (series)** — `cancelSeries` same pattern. **Fixed:** single `UPDATE … RETURNING id`.
- **P-W1 (pulse) + P-I15** — RSVP routes loaded the event row for the visibility gate, then `listRsvps`/`rsvpCounts`/`latestRsvps` re-fetched it internally. **Fixed:** services accept the already-loaded `Event`; routes thread the row from `loadVisibleEvent`. Visibility gating untouched. Review round (S-L3): the services only honour the hint when `event.id === eventId` — a mismatched row can never decide another event's authorization; on mismatch they silently re-load. See [[s2s-patterns]].
- **P-I7** — `createEvent` did INSERT + `getEvent` read-back. **Fixed:** `INSERT … RETURNING`; `applyTransition` kept on the returned row so status normalisation is unchanged.
- **P-I2 (pulse)** — Missing composite index for RSVP status filters. **Fixed:** `event_rsvps_event_status_idx (event_id, status)` in the Drizzle schema + hand-written migration 0008 with journal entry; flows into test DDL via `createSchemaSql()`. Review round (P-I1): the same migration drops the now-subsumed single-column `event_rsvps_event_idx` — three indexes led on `event_id`, pure write amplification on the RSVP path — mirroring cire migration 0026's drop-the-subsumed-index pattern.
- **P-I14** — `GET /events/:id/ics` had no caching headers. **Fixed (revised in the prep-pr review):** `Cache-Control: private, no-cache` + weak `ETag` on `(id, updatedAt)`; `If-None-Match` honoured with 304, including multi-value lists and `*` (RFC 9110 §13.1.2). The first cut used `max-age=300`, which S-M1 in the security review flagged: a browser cache keys on URL only, so a freshness window replays the 200 across auth-state changes without re-running the visibility gate — `no-cache` + ETag makes every reuse a gate-checked 304 while still skipping body regeneration.

### cire + clients

- **P-I2 (cire)** — `events_sort_order_idx` was dead after wedding scoping and `events_wedding_idx` forced an in-memory sort. **Fixed:** migration 0026 replaces both with composite `events_wedding_id_sort_idx (wedding_id, sort_order)` (filter + order in one B-tree, one less index on the import write path); Drizzle schema and the cire/api test-DDL lockstep mirror updated together. See [[cire]].
- **P-W10** — `RegistrationClient.checkHandle` had no `AbortController`, so debounced bursts stacked in-flight requests. **Fixed:** optional `AbortSignal` parameter; the debounced consumers (`Register`, `CreateProfileForm` in `@osn/ui`) abort the previous probe before each new one and on cleanup, with aborts never surfacing as error states.
- **P-W3 (explore)** — Canvas heatmap + SVG map redrew on every `ResizeObserver` frame. **Fixed:** `setSize` trailing-edge debounced 100 ms (first measurement immediate; timer cleared on cleanup).
- **P-W4 (explore)** — `StyleMap` grid-line geometry recalculated on every access. **Fixed:** `vLines`/`hLines`/`avenues`/`streets` are `createMemo`s keyed on the debounced size.
- **P-W5 (explore)** — `isDark()` read `classList` from the DOM on every access, non-reactively. **Fixed:** `useIsDark()` signal driven by a `MutationObserver` on the root/body `class` attributes (disconnected on cleanup); theme-derived fills are now reactive O(1) reads.

### Prep-PR review round (same branch)

The branch's own performance + security reviews surfaced findings against the sweep; fixed in-branch before merge (details inline above): **P-W1** (OR-join probe table scan → UNION ALL), **P-W2** (same-second cursor skip → composite keyset), **P-I1** (subsumed `event_rsvps_event_idx` dropped), **P-I4** (`hasMore`/`nextCursor` continuation metadata), **P-I5** (`getChatMembers` redundant existence load), plus security fixes S-M1/S-L2/S-L3 recorded in [[changelog/security-fixes]]. Accepted-with-rationale (not re-flag): **P-I2 (zap)** cursor resolution is a second round-trip (caller-scoped rejection contract kept simple; fold into the page query if zap list QPS matters), **P-I3 (zap)** `listChats` sorts the caller's full chat set per page (`USE TEMP B-TREE` — bounded by per-user membership; escape hatch is denormalising `created_at` onto `chat_members`), **P-I6 (pulse)** list GETs can still write status transitions (bounded to ≤ a handful of statements per request now; read-only derivation + background sweep is the follow-up shape), **P-I7 (osn)** recovery wrong-code path costs one extra classification SELECT (bounded by per-account lockout; the success-path race closure is worth strictly more). Availability note (C-L1, SOC 2 A1/CC7): the ceremony-store sweep semantics change and the two index-replacing migrations (cire 0026, pulse 0008) are the availability-relevant changes of this sweep — behaviour is strictly more bounded (debounced sweep cost, cap enforced on every write, fewer B-trees per write); see [[sessions]], [[cire]].

## OSN API per-request layer rebuild (2026-06-16)

- **P-W1 (osn-runtime)** — Every `@osn/api` route's `run` helper executed service effects via `Effect.runPromise(eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)))`. Because `Effect.provide` rebuilds a layer on each run and layer memoization is per-build, **every request reconstructed the entire layer graph**: the observability layer's `NodeSdk` (BatchSpanProcessor + OTLP trace/metric exporters + PeriodicExportingMetricReader) was started and then torn down per request, and `DbLive` opened a fresh, never-closed `bun:sqlite` connection each time. The OTel teardown blocks on an exporter flush — ≈3 s locally where no OTLP collector is listening. This was most visible on the debounced username-availability check (`GET /handle/:handle`), which fires repeatedly while typing: each pause stalled ~3 s. A focused benchmark measured ≈3019 ms/request for the provide-per-request pattern vs ≈0.09 ms/request against a shared runtime. **Fixed:** the application layer graph is built once at boot into a `ManagedRuntime` (`osn/api/src/index.ts`) and threaded through all nine route factories via `makeAppRunner` (`osn/api/src/lib/route-runtime.ts`); tests that pass a bare layer get a one-time `ManagedRuntime` wrapper instead of a per-request rebuild. Result: exactly one OTel SDK + one DB connection process-wide, and the SDK's own batch/flush timers handle export. See [[architecture/backend-patterns]] (“Build the layer graph ONCE”) and [[observability/overview]].

## Cire Hono → Elysia migration (2026-06-12)

- **P-W1 (cire-elysia)** — The Worker `fetch` handler rebuilt the entire app on every request. Cheap under Hono, but `createApp` now composes ~11 Elysia instances (root + cors + four route factories + five auth/rate-limit plugins) with scoped-hook lifting and dedup checksumming on each construction — and `aot: false` (required on Workers) means none of it is amortised by compilation. **Fixed:** the app is built once per isolate and memoized at module scope, guarded on D1-binding identity so a binding change forces a rebuild. Construction cost now lands once per cold start instead of on every request (including CORS preflights and the guest-facing claim/RSVP hot paths). Module-scoped state that must survive per-request rebuilds (`defaultClaimLimiter`, the shared JWKS cache) was already isolate-scoped, so behavior is unchanged. See [[cire]].

## Pulse ARC registration retry (2026-04-24)

- **P-I1 (arc-retry)** — The initial fix for the pulse-api boot-time ConnectionRefused crash retried at a fixed 5 s + 0-1 s cadence with no cap, so a developer leaving pulse-api running against a permanently-down osn/api would issue ~720 fetch attempts/hour indefinitely. Local-dev only, timer `.unref()`-ed, one-in-flight — no real memory or production risk, but noisy logs and socket churn that mask the "osn/api is broken" state. Fixed: exponential backoff starting at 5 s, doubling to a 5-minute ceiling — the same ceiling `rotateKey` already uses for post-boot rotation failures. Retry counter resets on every fresh `startKeyRotation` call so restarts always begin at the base delay. Covered by a test that walks three successive retries (5 s → 10 s → 20 s windows) — see [[arc-tokens]].
- **P-I2 (arc-retry)** — Jitter was one-sided (`Math.random() * JITTER`) so the effective window was `[base, base + jitter]`, never earlier. Cosmetic in practice, but the `rotateKey` comment specifies symmetric ±30 s jitter to avoid thundering-herd — the retry path should match that convention. Fixed: symmetric `(Math.random() - 0.5) * 2 * JITTER` gives `[base - jitter, base + jitter]` — see [[arc-tokens]].

## Auth Phase 5b (2026-04-22)

- **P-W1 (session)** — `trackRotatedSession` performed a JS-side map sweep on every `/token` refresh (O(n) amortised via FIFO). Fixed: the Redis-backed store delegates expiry to Redis's native per-key PX TTL; the in-memory fallback keeps the existing bounded FIFO sweep for single-process deployments. `track` is a single Redis round-trip on the `/token` hot path. — see [[sessions]]
- **P-W2 (session)** — Prior design kept a `{ns}:fam:{familyId}` JSON-array of tracked hashes and re-parsed/re-stringified it on every `track`. Over a 30-day active refresh chain (access-token TTL 5 min → ~8 640 rotations) that blob would have grown to ~550 KB of CPU + bandwidth per rotation. Fixed: dropped the family set. `track` writes one 64-hex hash key; `revokeFamily` is a no-op on Redis because the DB-level `DELETE FROM sessions WHERE family_id = ?` already revokes the sessions and the hash keys expire under their own TTL.
- **P-I1 (session)** — In-memory `revokeFamily` deleted from `entries` but left stale keys in the `order` FIFO queue, so the `ROTATED_SESSIONS_MAX` cap-driven eviction path could pop already-revoked entries. Fixed: filter the queue alongside the `entries` purge — one extra pass per revocation, which is rare.

## Auth Phase 5a (2026-04-19)

- **P-W1** — `revokeAccountSession` fetched all account sessions and JS-filtered to find the handle match. Fixed: `LIKE 'handle%'` on the indexed PK with `LIMIT 1` — O(1) instead of O(sessions-per-account).
- **P-W2** — `listAccountSessions` had no `LIMIT` and no composite index for its `ORDER BY lastUsedAt DESC`. Fixed: `LIMIT MAX_SESSIONS_PER_ACCOUNT` on the query plus a new composite index `sessions(account_id, last_used_at)` served by migration 0005.
- **P-W3** — Email-change rate-cap scan fetched full history and JS-filtered the 7-day window. Fixed: `count()` with `gte(completedAt, windowStart)` predicate served by `email_changes_completed_at_idx`.
- **P-W4** — `verifyRefreshToken` wrote `last_used_at` on every verify (hot-path write amplification). Fixed: coalesce writes to a 60-second threshold — ~60× fewer writes at typical 5-min refresh cadence.
- **P-I3** — Step-up / email-change in-memory ceremony stores didn't sweep on insert. Fixed: `sweepExpired` on every `set` so abandoned ceremonies don't linger.
- **P-I4** — `completeEmailChange` held the writer lock across three reads (account fetch, history count, collision check) plus the writes. Fixed: preflight moved out of the transaction; collision race handled by the UNIQUE(email) constraint catching winners inside the TX.
- **P-I5** — `rotatedSessions` sweep was O(n) per insert → O(n²) over the 30-day window. Fixed: FIFO queue so sweep only inspects the head; belt-and-braces size cap at 100k entries.

## Critical

- **P-C1** — N+1 `getAttendanceVisibility` in `filterByAttendeePrivacy`. Fixed: batch query with `getAttendanceVisibilityBatch`.
- **P-C1 (zap)** — N+1 query in `listChats`. Fixed: single `inArray` query.
- **P-C2 (zap)** — `createChat` inserted members one-by-one. Fixed: batch insert.
- **P-C1 (multi)** — Passkey login query used profile ID against account-scoped column. Fixed: uses `accountId`.
- **P-C2 (multi)** — `users.email` index dropped during schema rewrite. Fixed: re-added `users_email_idx`.

## Warning

- **P-W1** — `rateLimitStore` in graph routes unbounded. Fixed: shared `createRateLimiter` with sweep + maxEntries.
- **P-W6** — N+1 queries in graph list functions. Fixed: `inArray` batch fetches.
- **P-W7** — `eitherBlocked` two sequential `isBlocked` calls. Fixed: single OR query.
- **P-W8** — `blockProfile` SELECT-then-DELETE. Fixed: direct `DELETE WHERE OR`.
- **P-W9** — Extra `getEvent` round-trip in `updateEvent`. Fixed: returns in-memory merged result.
- **P-W12** — `listEvents` clamped with LIMIT before JS visibility filter. Fixed: pushed to SQL `WHERE`.
- **P-W13** — `getConnectionIds`/`getCloseFriendIds` capped at 100 (same root as S-M28). Fixed: raised to `MAX_EVENT_GUESTS`.
- **P-W14** — `MapPreview` + Leaflet (~150KB) shipped on every cold start. Fixed: `lazy()` route loading + dynamic Leaflet import.
- **P-W15** — Observability plugin no-op `context.with` call broke parent-based sampling. Fixed: removed, OTel context stashed on `REQUEST_STATE`.
- **P-W16** — Auth rate limiter Maps swept proactively. Fixed: sweep on every `check()`.
- **P-W16** (graph) — Missing index on `close_friends.friend_id`. Fixed: added `close_friends_friend_idx`.
- **P-W17** — Redirect URI allowlist pre-computed. Fixed: `allowedOrigins` Set built once at boot.
- **P-W17** (graph) — `removeConnection` and `blockProfile` not in transaction. Fixed: `db.transaction()`.
- **P-W18** — `@shared/redis` sent full Lua script on every EVAL. Fixed: EVALSHA caching with NOSCRIPT fallback.
- **P-W19** — `@shared/redis` `createMemoryClient` no expiry sweep. Fixed: proactive sweep.
- **P-W20** — Double base64-decode in `requireArc`. Fixed: single `peekClaims()`.
- **P-W21** — Unbounded `profileIds` on batch internal graph endpoints. Fixed: `maxItems: 200`.
- **P-W1 (org)** — Sequential queries in `createOrganisation`. Fixed: `Promise.all`.
- **P-W2 (org)** — Sequential queries in `addMember`. Fixed: parallelised.
- **P-W4 (org)** — `listProfileOrganisations` two-step query. Fixed: single `innerJoin`.
- **P-W5 (org)** — `listMembers` two-step query. Fixed: single `innerJoin`.
- **P-W6 (org)** — `updateOrganisation` re-fetched after update. Fixed: constructs from known state.

## Info

- **P-I3** — `isCloseFriendOf` used `SELECT *`. Fixed: projects only PK.
- **P-I4** — `getCloseFriendsOfBatch` unbounded array. Fixed: clamped to 1000.
- **P-I10** — `Register.tsx` `createEffect` for passkey skip. Fixed: imperative call.
- **P-I11** — `Register.tsx` unnecessary `createMemo`. Fixed: inlined.
- **P-I12** — `Register.tsx` reallocated `RegistrationClient` on every mount. Fixed: module scope.
- **P-I14** — `@shared/redis` `checkRedisHealth` timeout timer leaked. Fixed: `clearTimeout` in `.finally()`.
- **P-I15** — `@shared/redis` `RedisLive` startup ping no timeout. Fixed: 5s timeout.
- **P-I16** (redis) — `void Effect.runPromise(...)` fire-and-forget log in `initRedisClient()`. Fixed: warning-level logs `await`-ed.
- **P-I16** (observability) — `redact()` unconditionally walked every payload. Fixed: primitive fast path.
- **P-I17** — `listEvents`/`listTodayEvents` unbounded concurrency on `applyTransition`. Fixed: bounded to 5.
- **P-I18** — `instrumentedFetch` allocated fresh `Headers` unnecessarily. Fixed: reuse caller's instance.
- **P-I1 (org)** — `createOrganisation` re-fetched inserted org. Fixed: constructs from known inputs.
