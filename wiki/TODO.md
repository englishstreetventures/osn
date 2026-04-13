# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md. For detailed system docs see [[index]].

## Up Next

- [x] S-H21 — Migrated the three dev-mode `console.log` calls in `osn/core/src/services/auth.ts` (registration OTP, login OTP, magic link) to `Effect.logDebug`. Values stay interpolated into the message string so the redacting logger doesn't scrub them — that's the whole point of the dev branch. The registration path keeps its `NODE_ENV !== "production"` gate; the login OTP / magic-link branches still rely on `config.sendEmail` being unset, which is the existing behaviour (S-M22 follow-up tracks tightening that to a `NODE_ENV` gate as well). Also threaded an optional `loggerLayer` parameter through `createAuthRoutes` / `createGraphRoutes` so `@osn/app` can provide its `observabilityLayer` to per-request Effect pipelines (S-L1 — without this the new `Effect.logDebug` calls would be silently dropped at Effect's default `Info` minimum level). Coverage locked with three `it.effect` tests (T-U1) using a `Logger.replace` capture sink that asserts the literal OTP/URL appears in the message and `[REDACTED]` never does.
- [ ] Provision Grafana Cloud free tier + wire `OTEL_EXPORTER_OTLP_ENDPOINT` + headers into deploy env — see [[observability-setup]]
- [ ] Build first observability dashboards (HTTP RED, auth funnel, ARC verification, events CRUD) — see [[observability/overview]]
- [x] Zap M0 scaffold (partial) — `@zap/api` (Elysia, port 3002), `@zap/db` (Drizzle) with chat/message schema, Effect services, 33 tests. `@zap/app` (Tauri+Solid) deferred. Pulse event-chat integration via `zapBridge` + `chatId` column on events.
- [ ] Zap route-level tests + zapBridge tests (T-R1, T-M1 from review)
- [ ] Zap rate limiting on write endpoints (S-M1) — see [[rate-limiting]]
- [ ] Pulse: "What's on today" default view
- [ ] Landing page: design and content
- [x] S-H1 — Rate limit all auth endpoints (per-IP fixed-window via `osn/core/src/lib/rate-limit.ts`; 5 req/min on begin/send endpoints, 10 req/min on verify/complete; new `osn.auth.rate_limited` metric with bounded `AuthRateLimitedEndpoint` union)
- [x] S-H3 — Open redirect in `/magic/verify` fixed: `allowedRedirectUris` field on `AuthConfig`; validated at `/authorize`, `/magic/verify` (service-level), and `/token` (route-level origin match + S-M9 exact redirect_uri match against pkceStore)
- [x] S-H4 — PKCE now mandatory at `/token`: `state` and `code_verifier` required for `authorization_code` grants; unknown/expired state returns 400; redirect_uri must match the value stored at `/authorize` (S-M9 RFC 6749 §4.1.3)
- [x] S-H5 — Legacy unauth'd passkey path removed: `resolvePasskeyEnrollPrincipal` now returns 401 when `Authorization` header is absent. Hosted `/authorize` HTML passkey-enrollment prompt removed (passkey enrollment requires auth; users enrol through first-party apps). `console.warn` deprecation log removed. `SimpleWebAuthn` script tag removed from hosted HTML.
- [x] ARC token verification middleware on internal graph routes (`/graph/internal/*`) — see [[arc-tokens]], [[arc-token-debugging]]. Implemented `requireArc` middleware in `osn/core/src/lib/arc-middleware.ts` and seven `/graph/internal/*` read-only endpoints (either-blocked, connection-status, connections, close-friends, is-close-friend, close-friends-of, user-displays) in `osn/core/src/routes/graph-internal.ts`. 21 new tests.
- [x] Redis migration — Phase 3 (wire up rate limiters) done: `createRedisAuthRateLimiters()` + `createRedisGraphRateLimiter()` factories in `osn/core`, env-driven backend selection in `osn/app` (`REDIS_URL` → Redis, unset → in-memory), 10 integration tests. Resolves S-M2 for production. Phase 4 (auth state migration) is next — see [[redis]]

---

## Pulse (`pulse/app` + `pulse/api` + `pulse/db`)

- [x] Initialize Tauri app with SolidJS
- [x] iOS target configured
- [x] Event data model and schema
- [x] Event CRUD operations (list, today, get, create, update, delete)
- [x] Event CRUD UI (create form, delete, Eden client, shadcn tokens)
- [x] Event lifecycle auto-transitions (on-read, no background job)
- [x] Location autocomplete (`LocationInput` with debounce/abort)
- [x] Auth callback handler (`CallbackHandler`)
- [x] Test coverage: utils, LocationInput, CreateEventForm end-time validation
- [x] Test coverage: EventCard, CreateEventForm (full), EventList (auth/unauth)
- [x] Toast notification system (solid-toast: event created, deleted, create/delete errors)
- [x] Registration UI: multi-step flow (email + handle + display name → OTP → passkey enrolment), live handle availability check, auto-login on completion via `adoptSession`
- [x] Coordinate storage (lat/lng from Photon autocomplete) + Maps button on EventCard
- [x] Full event view at `/events/:id` with shareable URL (client routing via `@solidjs/router`)
- [x] Map preview in expanded event view (Leaflet + OpenStreetMap, no API key)
- [x] iCal export (ICS) — `GET /events/:id/ics` + Add-to-calendar button
- [x] RSVP service: upsert/list/counts/invite, cross-DB join with `@osn/db` user displays
- [x] RSVP visibility filtering — public / connections / private guest list, with per-attendee `attendanceVisibility` (`connections` / `no_one`) honoured server-side. Close-friend attendees are surfaced first in the returned list as a display signal.
- [x] Event public/private discovery flag — `listEvents` filters out private events from non-owners
- [x] Join policy — `open` vs `guest_list` (invited users only)
- [x] Allow-interested toggle for events that don't accept "Maybe" RSVPs
- [x] Communications config (`commsChannels`) and stubbed blast log (`event_comms` table); organiser-only `POST /events/:id/comms/blasts`
- [x] Per-step info popovers in `CreateEventForm`
- [x] `pulse_users` table for Pulse-side user settings (separate from OSN identity)
- [x] `PATCH /me/settings` route for attendance visibility
- [x] Event chat placeholder (will be replaced with Zap M2)
- [ ] "What's on today" default view
- [ ] Prompt for max event duration when creating events without an endTime
- [ ] Event discovery (location, category, datetime, friends, interests)
- [ ] Recurring events (series + instances)
- [ ] Event group chats (via Zap once M2 lands — placeholder shipped)
- [ ] Hidden attendance option (delivered above as `attendanceVisibility = "no_one"`)
- [ ] Organizer tools (moderation, blacklists)
- [ ] Venue pages
- [ ] Real SMS/email comms providers — `sendBlast` is stubbed (writes to `event_comms`); plug in actual delivery
- [ ] Tighten Tauri CSP to allowlist `*.tile.openstreetmap.org` for the new Leaflet tile loads (rolls into S-L3)
- [ ] Drizzle: `@pulse/db` test helpers (`tests/schema.test.ts`, `tests/seed.test.ts`, `pulse/api/tests/helpers/db.ts`) hand-roll the SQL schema in three places — extract a shared `createSchemaSql()` helper so adding a column is a one-file change
- [ ] Verified-organisation tier (Pulse phase 2): organisation accounts can run events over `MAX_EVENT_GUESTS` (1000) via a per-event support flow that bumps the cap. Required for conferences / festivals / large weddings. Blocks: org claim on JWT, support request flow, billing, dashboards.
- [x] Once `@osn/core` exposes a directional `isCloseFriendOf(attendee, viewer)` graph helper, drop the `getCloseFriendsOf` SQL query from `pulse/api/src/services/graphBridge.ts` and call the service helper instead. Done: `isCloseFriendOf`, `getCloseFriendsOfBatch` added to graph service; bridge migrated to use service helper.

---

## OSN Core (`osn/app` + `osn/core`)

- [x] OAuth/OIDC provider (passkey, OTP, magic link, PKCE, JWT) in `@osn/core`
- [x] User registration/login flows
- [x] `osn/app` auth server entry point (port 4000)
- [x] 50 tests: services, routes, lib/crypto, lib/html
- [x] Social graph data model (connections, close friends, blocks) — 209 tests
- [x] Handle system — registration, real-time availability check, email/handle sign-in toggle
- [x] ARC token verification middleware on internal graph routes (`/graph/internal/*`)
- [x] Organisation support — schema (`organisations`, `organisation_members`), Effect service, REST routes, ARC internal routes, observability metrics, 355 tests
- [ ] Per-app vs global blocking logic (deferred — global blocking across all OSN apps for now)
- [ ] Interest profile selection (onboarding)
- [ ] Third-party app authorization flow
- [ ] Organisation frontend — management UI in Pulse or standalone `@osn/social` Tauri app
- [ ] Unified `handles` reservation table (user + org handles share namespace; currently enforced at service layer — see Deferred Decisions)

---

## Zap (`zap/app` + `zap/api` + `zap/db`)

OSN's messaging app. Currently a placeholder — `zap/` exists with a
README and is wired into the workspaces glob, but no workspaces have
been scaffolded yet. Stack matches Pulse (Bun, Tauri+Solid, Elysia+Eden,
Drizzle+SQLite, Effect.ts) unless a real reason emerges to diverge.
Signal Protocol lives in `@osn/crypto`, not `zap/`.

### M0 — Scaffold (no behaviour, just the skeleton)

- [ ] `bunx create-tauri-app` for `@zap/app` (iOS target enabled, Solid template)
- [x] `@zap/api` workspace (Elysia + Eden, port 3002, mirror `@pulse/api` layout)
- [x] `@zap/db` workspace (Drizzle + SQLite, mirror `@pulse/db` layout)
- [ ] `@zap/app` consumes `@osn/client` + `@osn/ui/auth` for sign-in (re-uses the same `<SignIn>` / `<Register>` from Pulse)
- [x] Initial test infra (`tests/helpers/db.ts`, `createTestLayer()`) for `@zap/api` and `@zap/db`
- [x] Add `@zap/api`, `@zap/db` to the turbo pipeline (build / check / test)
- [ ] Register `zap-app` and `zap-api` in `service_accounts` (ARC token issuer rows)

### M1 — 1:1 DMs (E2E)

- [ ] Signal Protocol primitives in `@osn/crypto/signal` (X3DH handshake, double ratchet)
- [x] `@zap/db` schema: `chats`, `chat_members`, `messages` (device_keys, prekey_bundles deferred to E2E crypto work)
- [x] `@zap/api` routes: chat CRUD, member management, message send/list with cursor pagination
- [ ] WebSocket transport for live message delivery (`@zap/api`)
- [ ] Push receipt + read receipt model (defer push notifications themselves to M4)
- [ ] `@zap/app` Socials view: chat list + message thread UI
- [ ] Resolve recipients via `@osn/client` (handle → user lookup) + ARC-gated `/graph/internal/connections` to filter out blocked users
- [ ] Test coverage: handshake, ratchet, message ordering, blocked-user enforcement
- [ ] Disappearing messages flag at chat level + per-message TTL sweep

### M2 — Group chats

- [ ] Group session establishment (sender keys or MLS — pick one and document)
- [ ] `@zap/db` schema: `chat_role` (admin/member), `chat_invites`
- [ ] Add/remove members, role transitions, invite links
- [ ] Group-level disappearing-message defaults
- [x] Event chat linking: `chatId` column on events, `zapBridge` provisions Zap event chat and links it to the Pulse event
- [ ] Show linked event overview inside the chat settings sheet (read from `@pulse/api` via Eden or ARC-gated S2S)
- [ ] Test coverage: group rekeying on member removal, race conditions on simultaneous joins

### M3 — Organisation chats (the differentiator)

- [x] `organisations` + `organisation_members` tables in `@osn/db` (owner, handle, admin/member roles; verified flag deferred)
- [ ] Verification flow (manual review for now; document the criteria)
- [ ] `org_chats` and `org_agents` schemas in `@zap/db` — assignment, queue, status (open/pending/resolved), SLA timestamps
- [ ] Organisation-side dashboard (separate `@zap/app` view, role-gated): inbox, agent assignment, transcript export, analytics
- [ ] Embeddable web widget — small standalone bundle (Vite + Solid) shipped from `@zap/api` static, accepts an OSN handle and opens a conversation under the calling org
- [ ] E-commerce checkout integration: capture OSN handle alongside email at checkout, surface order context to org agents
- [ ] Public REST API for orgs to ingest support context from third-party systems (Zendesk-shaped surface)

### M4 — Locality / government channels

- [ ] Locality opt-in flow in `@zap/app` (permanent home + temporary travel subscriptions with expiry)
- [ ] `localities` and `locality_subscriptions` schemas in `@zap/db`; `locality_org` join to organisations
- [ ] Push channel for verified locality/government broadcasts (one-way; users can ask follow-ups via the org channel)
- [ ] AI-assisted query endpoint scoped to a locality ("nearest relief centre to my location") — defer model choice
- [ ] Privacy: locality stored on device + minimal server-side join; user-resettable per the OSN data principles
- [ ] Test coverage: travel subscription expiry, broadcast fan-out, query authority filtering

### M5 — Polish + AI view + native

- [ ] Themes (token-driven, share `@osn/ui` design tokens once those exist)
- [ ] Stickers + GIFs (third-party provider TBD; needs CSP review)
- [ ] Polls (per-chat, with privacy mode)
- [ ] Easter-egg mini-games (scoped, opt-in)
- [ ] AI view: dedicated tab for model conversations, quarantined from the Socials inbox; user-selectable model
- [ ] Push notifications (APNs first, FCM later — ties to Android deferral)
- [ ] Backup options: encrypted cloud / self-hosted / local-only
- [ ] Device transfer flow (key migration, backup restore)

### Cross-cutting / open questions

- [ ] Signal vs MLS for group chats — Signal sender-keys is simpler; MLS scales better past ~50 members. Decide before M2.
- [ ] Storage backend at scale: SQLite is fine for a single Bun process but messages have very different access patterns to events/users. Revisit when message volume forces it (likely Postgres / Supabase, possibly with an object store for media).
- [ ] Message media (images, video, voice notes) — needs E2E-friendly blob storage. Defer to post-M2.
- [ ] Spam / abuse model for organisation handles — verification gate is M3 but we'll need ongoing review tooling.

---

## Landing (`osn/landing`)

- [x] Astro + Solid scaffolding
- [ ] Design and build landing page content
- [ ] Deploy (Vercel/Cloudflare)

---

## Platform

### Pulse events API (`pulse/api`)

- [x] Elysia setup + Eden client
- [x] Effect.ts trial integration
- [x] Events domain (list, today, get, create, update, delete) — 47 tests
- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (currently N individual writes)
- [ ] Eliminate extra `getEvent` round-trips in `createEvent`/`updateEvent` via `RETURNING *`
- [ ] S2S graph access: add `@osn/core` + `@osn/db` deps; use `createGraphService()` read-only for event filtering (`hideBlocked`, `onlyConnections`) — first ARC token consumer
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`osn/db`, `pulse/db`)

- [x] Per-app DB packages (osn-db, pulse-db)
- [x] Pulse: events schema, migrations, smoke tests
- [x] OSN Core: users + passkeys schema, migration, smoke tests
- [x] OSN Core: social graph schema (connections, close_friends, blocks)
- [x] OSN Core: `service_accounts` table — `service_id`, `public_key_jwk`, `allowed_scopes` (for ARC token verification)
- [ ] OSN Core: session schema (JWT-based for now; DB storage deferred)
- [ ] Pulse: event series schema
- [x] Pulse: `chatId` column on events (links to `@zap/db` chats); full chat/message schema in `@zap/db`
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema

### Auth Client (`osn/client`)

- [x] Eden client wrapper
- [x] `getSession()` with expiry check
- [x] `AuthProvider` + `handleCallback` for SolidJS
- [x] 10 tests

### Crypto (`osn/crypto`)

- [x] `generateArcKeyPair()` — ES256 keypair generation
- [x] `createArcToken(privateKey, { iss, aud, scope, ttl? })` — signs and returns a short-lived JWT
- [x] `verifyArcToken(token, publicKey)` — verifies signature, expiry, audience, scope
- [x] `resolvePublicKey(iss)` — looks up public key from `service_accounts` table (Effect-based, requires Db)
- [x] In-memory token cache with 30s-before-expiry eviction (`getOrCreateArcToken`)
- [x] Key import/export utilities (`exportKeyToJwk`, `importKeyFromJwk`)
- [ ] JWKS URL fallback in `resolvePublicKey` for third-party apps

### UI Components (`osn/ui`)

- [ ] Design system / tokens
- [ ] Button, Input, Card basics
- [ ] Chat interface (shared between Pulse and Messaging)
- [ ] Event card component
- [ ] Calendar component

### Infrastructure

- [x] Turborepo + Changesets
- [x] Shared TypeScript configs
- [x] CI/CD (GitHub Actions) — lint, format, typecheck, tests, security review
- [x] lefthook pre-commit/pre-push hooks
- [x] oxlint + oxfmt
- [x] Claude Code GitHub integration
- [x] Claude skills: review-security, review-performance, review-tests, prep-pr, review-deps
- [x] UserPromptSubmit hook for tone enforcement
- [x] Changeset Check workflow runs `bunx changeset status` so a `.changeset/*.md` referencing a non-existent workspace name fails the PR — previously such typos blew up the Release workflow on main and blocked all subsequent versioning (e.g. `"pulse"` instead of `"@pulse/app"` in `fix-handle-regex-error-message.md`).

### Redis Migration (S-M2 umbrella) — see [[redis]]

Migrate in-memory rate limiters and auth state stores to Redis for horizontal scaling.
Subsumes: S-M2, S-M8, P-W1, P-W4, S-L18, S-L23. See [[rate-limiting]] for current implementation.

**Phase 1 — Abstraction layer (no Redis dependency)**
- [x] Extract `RateLimiterBackend` interface from `osn/core/src/lib/rate-limit.ts` — backend-agnostic `check(key): boolean | Promise<boolean>`
- [x] Refactor graph route inline `rateLimitStore` + `checkRateLimit` (`osn/core/src/routes/graph.ts:10-30`) to use shared `createRateLimiter` from `rate-limit.ts` (fixes P-W1, S-L18)
- [x] Update `createAuthRoutes` and graph route factories to accept injected rate limiter instances (DI for testability)

**Phase 2 — `@shared/redis` package**
- [x] Create `shared/redis` workspace (`@shared/redis`) — mirrors `@shared/db-utils` pattern
- [x] Effect-based `Redis` service tag (`Context.Tag`) + `RedisLive` layer (connection from `REDIS_URL` env); `Layer.scoped` finalizer calls `redis.quit()`
- [x] `RedisError` tagged error (`Data.TaggedError`, `_tag: "RedisError"`)
- [x] `createRedisRateLimiter(config)` — Lua script for atomic INCR + PEXPIRE (single round-trip fixed-window); key format `rl:{namespace}:{key}`
- [x] Redis health probe for `/ready` endpoint (simple `PING` with timeout)
- [x] Dev-mode: in-memory fallback when `REDIS_URL` is unset (local dev without Redis) — `createMemoryClient()` + `RedisMemoryLive` layer
- [x] Tests: Lua script atomicity, window expiry, key independence, connection failure fallback — 13 tests across 3 files

**Phase 3 — Wire up**
- [x] Add `@shared/redis` dependency to `osn/core/package.json` and `osn/app/package.json`
- [x] `createClientFromUrl()` factory in `@shared/redis/client` — encapsulates ioredis constructor
- [x] `createRedisAuthRateLimiters(client)` + `createRedisGraphRateLimiter(client)` factories in `osn/core/src/lib/redis-rate-limiters.ts`
- [x] Env-driven backend selection in `osn/app/src/index.ts`: `REDIS_URL` → Redis with startup health check; unset → in-memory fallback; graceful fallback on connection failure
- [x] All 12 rate limiters (11 auth + 1 graph) now use Redis backends when available
- [x] 10 new integration tests verifying Redis-backed limiters integrate with route factories
- [x] Updated CLAUDE.md Rate Limiting section + [[rate-limiting]] wiki page to document the two-backend model

**Phase 4 — Auth state migration (S-M8, follow-up)**
- [ ] `otpStore` → Redis with TTL (resolves S-M8 partial, P-W4 partial)
- [ ] `magicStore` → Redis with TTL (resolves S-M8 partial, P-W4 partial)
- [ ] `pkceStore` → Redis with TTL + size bound (resolves S-M8 partial, S-L23)
- [ ] `pendingRegistrations` → Redis with TTL

**Observability (applied across all phases)**
- [ ] Logs: `Effect.logError` on Redis connection failures + command errors; `Effect.logWarning` on fallback-to-in-memory transitions; add `redisPassword` / `redis_password` to redaction deny-list in `shared/observability/src/logger/redact.ts`
- [ ] Traces: `Effect.withSpan("redis.rate_limit.check")`, `Effect.withSpan("redis.connection.health")`, `Effect.withSpan("redis.auth_state.get|set")` (Phase 4)
- [ ] Metrics in `shared/redis/src/metrics.ts`: `redis.command.duration` histogram (`{ command: RedisCommand, result: RedisResult }`), `redis.command.errors` counter (`{ command: RedisCommand, error_type: RedisErrorType }`), `redis.connection.state` up/down gauge; bounded attrs: `RedisCommand = "evalsha" | "ping" | "get" | "set" | "del" | "incr" | "other"`, `RedisResult = "ok" | "error" | "timeout"`
- [ ] Capacity metrics: `redis.memory.bytes` gauge (from periodic `INFO memory` → `used_memory`; alert at 80% of `maxmemory`), `redis.store.keys` gauge per namespace (`{ namespace: RedisNamespace }` where `RedisNamespace = "rate_limit" | "otp" | "magic" | "pkce" | "pending_registration"`; sampled via `SCAN` count or key-prefix `DBSIZE` equivalent). These are the at-a-glance indicators for whether we're approaching Redis capacity limits.

---

## Security Backlog

Address **High** items before any non-local deployment.

### Critical

- [x] S-C1 — Unbounded HTTP route metric cardinality from raw URL paths. Plugin initialised `state.route = url.pathname` and only upgraded to the route template in `onAfterHandle`, so any 404 or short-circuiting request recorded the raw path as the metric label — financial DoS on Grafana Cloud billing + path-segment leakage into observability storage. Fixed: default `state.route = "unmatched"`, only overwrite from Elysia's route template.
- [x] S-C2 — Untrusted ARC `iss` claim became metric label before verification. `metricArcPublicKeyCacheMiss(issuer)` was called with the caller-supplied issuer *before* the DB lookup proved it existed. Fixed: (a) moved miss-metric emission to after `service_accounts` lookup succeeds, unknown issuers record against `"unknown"`; (b) added `safeIssuer()` runtime guard in `arc-metrics.ts` — any `iss`/`aud` not matching `/^[a-z][a-z0-9-]{1,30}$/` collapses to `"unknown"` as defence-in-depth.
- [x] S-C3 — User-supplied `category` was unbounded on `pulse.events.created`. The metric typed `category: string` (despite CLAUDE.md's string-literal-union rule), letting any authenticated Pulse user blow up cardinality via `category: crypto.randomUUID()`. Fixed: closed `AllowedCategory` union (13 values) + `bucketCategory()` helper that collapses anything else to `"other"`.

### High

- [x] S-H1 — Rate limit all auth endpoints via per-IP fixed-window limiter (`osn/core/src/lib/rate-limit.ts`). 5 req/IP/min on OTP/magic send endpoints, 10 req/IP/min on verify/complete. `osn.auth.rate_limited` metric with bounded `AuthRateLimitedEndpoint` type. Also covers S-H2 (handle check: 10 req/IP/min).
- [x] S-H2 — `GET /handle/:handle` rate limited at 10 req/IP/min (fixed as part of S-H1)
- [x] S-H3 — Open redirect in `/magic/verify` fixed: `allowedRedirectUris` on `AuthConfig` validates redirect_uri origin at `/authorize`, `/magic/verify`, and `/token`.
- [x] S-H4 — PKCE now mandatory at `/token`: `state` and `code_verifier` required for `authorization_code` grants. Also validates redirect_uri match (S-M9 RFC 6749 §4.1.3).
- [x] S-H5 — Legacy unauth'd passkey path removed. `resolvePasskeyEnrollPrincipal` returns 401 without Authorization header. Hosted HTML passkey prompt + SimpleWebAuthn script removed.
- [x] S-H6 — No auth/authorisation middleware on API routes (OWASP A01) — POST/PATCH/DELETE require auth; unauthenticated → 401
- [x] S-H7 — No ownership check on mutating event operations — createdByUserId NOT NULL; 403 on non-owner
- [x] S-H8 — Graph GET endpoints unguarded — all GET handlers wrapped in try/catch; generic "Request failed" on unexpected errors
- [x] S-H9 — `/register/complete` exploited a pre-existing PKCE bypass at `/token` to mint a session — fixed in the registration flow redesign: `register/complete` now issues access + refresh tokens directly and the registration code path never calls `/token`. Underlying `/token` bypass is tracked separately as S-H4.
- [x] S-H10 — TOCTOU between OTP verify and user insert in `completeRegistration` — fixed: insert is attempted directly, the unique constraint is the source of truth, and a losing race no longer burns the pending OTP entry.
- [x] S-H11 — `email.toLowerCase()` was used as the pending-registrations map key but the original-cased value was persisted, allowing two near-duplicate accounts — fixed: the lowercased value is now the canonical form throughout the registration pipeline (the legacy `/register` path is unchanged; tracked as S-M19 below).
- [x] S-H12 — `GET /events/:id` did not gate by `visibility`. `listEvents` filtered private events from discovery but direct ID fetch returned full event details to anyone with the URL (incl. unauthenticated). Fixed in the full-event-view PR via shared `loadVisibleEvent` helper in `pulse/api/src/services/eventAccess.ts` — returns 404 (not 403) to non-authorised viewers to avoid existence disclosure.
- [x] S-H13 — `GET /events/:id/ics` had the same root cause as S-H12 — leaked private event metadata including GEO coordinates as a downloadable file. Fixed via `loadVisibleEvent`.
- [x] S-H14 — `GET /events/:id/comms` had the same root cause as S-H12 — leaked organiser blast bodies (which may contain venue codes, addresses, dress codes). Fixed via `loadVisibleEvent`.
- [x] S-H15 — `GET /events/:id/rsvps?status=invited` leaked the organiser's invite list to anyone (or to any of the organiser's connections for connections-gated events). Invitees never opted in (the public-guest-list override applies only to people who have actually attended). Fixed in `listRsvps`: queries with `status: "invited"` return empty unless the viewer is the event organiser.
- [x] S-H16 — `GET /events/:id/rsvps/counts` leaked existence + activity of private events. Fixed via the shared `loadVisibleEvent` gate.
- [x] S-H17 — `/ready` readiness probe leaked internal error messages (driver text, hostnames, connection strings) to unauthenticated callers when the probe threw. Fixed: `/ready` now returns a fixed opaque `{ status: "not_ready", service }` body regardless of why the probe failed; the underlying cause is routed to operators via `Effect.logError`. `false`-return and thrown-probe responses are byte-identical.
- [x] S-H18 — Inbound W3C `traceparent` was honoured unconditionally, letting external attackers force 100% sampling + inject chosen trace IDs into internal traces (privilege escalation across observability trust boundaries). Fixed: plugin only extracts upstream trace context when the caller presents an `Authorization: ARC ...` header; anonymous/public requests start a fresh root span. Trust boundary now matches the ARC S2S auth boundary.
- [x] S-H19 — Client-supplied `x-request-id` was echoed + logged unsanitised (log injection via CRLF, ANSI escape hijack of operator terminals, storage bloat via unbounded length). Fixed: inbound values must match `/^[A-Za-z0-9_.-]{1,64}$/`; anything else is discarded and replaced with a freshly generated ID. Bun's `Request` already rejects literal CRLF at construction; our regex is the second layer.
- [x] S-H20 — Outbound `instrumentedFetch` set `url.full` to the full URL including query string — OAuth `code`, magic-link `token`, presigned S3 signatures, OTP callbacks would all land in trace storage. Fixed: span now records `<scheme>://<host><path>` only (no query component); `url.path` remains available for routing without the secret payload.
- [ ] S-H21 — Dev-mode `console.log` of OTP codes + recipient email + magic-link URLs still present in `osn/core/src/services/auth.ts` (`beginRegistration`, `beginOtp`, `beginMagic`). CLAUDE.md's first golden rule bans raw `console.*` in backend code, and the redactor only protects `Effect.log*` — raw `console.log(email + code)` bypasses the deny-list entirely. **Deferred to the follow-up "console migration" PR by user direction.** Fix: replace each site with `Effect.logDebug` + structured annotations (which the redactor will scrub correctly).

### Medium

- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — old tokens 401 silently; treat missing `handle` as `null` during transition period
- [x] S-M2 — In-memory rate limiter resets on restart/deploy — migrated to Redis shared counter (Phase 3). All 12 rate limiters now use Redis when `REDIS_URL` is set, with in-memory fallback. Cross-refs: S-M8 (Phase 4), P-W1 (Phase 1), P-W4 (Phase 4), S-L18 (Phase 1), S-L23 (Phase 4) — see [[rate-limiting]], [[redis]]
- [ ] S-M3 — No "resend code" button after registration OTP; if SMTP fails, handle/email are claimed with no recovery path. Partly mitigated by the new flow's "refuse to overwrite a non-expired pending entry" policy (the user retries via the existing pending entry, no new email is sent), but a true resend button is still needed.
- [ ] S-M4 — Legacy `POST /register` (unverified email) returns raw `String(catch)` error — can expose Drizzle constraint internals. The new `/register/{begin,complete}` routes already use the `publicError()` mapper from `routes/auth.ts`; extend the same mapper to the legacy endpoint and to all other routes that still use `String(e)`.
- [ ] S-M5 — `displayName` embedded in JWT (1h TTL) — stale after profile update; `createdByName` on events reflects old value until token expires
- [ ] S-M6 — Wildcard CORS on auth server — restrict to known client origins before deployment
- [x] S-M7 — Login OTP attempt limit added: `verifyOtpCode` now increments `entry.attempts` on wrong-code and wipes the entry after `MAX_OTP_ATTEMPTS` (5) wrong guesses, mirroring the registration flow.
- [ ] S-M8 — All auth state in process memory (`otpStore`, `magicStore`, `pkceStore`) — lost on restart, unsafe for multi-process. Resolved by Redis Migration Phase 4 — see [[redis]]
- [x] S-M9 — `redirect_uri` at `/token` now matched against value stored in `pkceStore` (RFC 6749 §4.1.3); fixed as part of S-H4.
- [x] S-M10 — `/passkey/register/begin` arbitrary `userId` fixed: Authorization header now required (fixed as part of S-H5).
- [ ] S-M11 — Magic-link tokens use `crypto.randomUUID` without additional entropy hardening
- [x] S-M12 — `limit` query param in `listEvents` uncapped — clamped to 1–100 in service layer
- [ ] S-M13 — Photon (Komoot) geocoding: keystrokes sent to third-party with no user notice — add consent UI or proxy
- [ ] S-M14 — Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side; tracked as S-H3
- [x] S-M15 — `is-blocked` route leaked whether target had blocked caller — route now uses `isBlocked(caller, target)` only
- [x] S-M16 — No rate limiting on graph write endpoints — module-level fixed-window limiter added (60/user/min)
- [x] S-M17 — Raw DB/Effect errors surfaced in graph responses — `safeError()` helper; only `GraphError`/`NotFoundError` messages exposed
- [x] S-M18 — No input validation on `:handle` route param in graph routes — TypeBox `HandleParam` with regex + length bounds added
- [ ] S-M19 — Legacy `/register` does not lowercase emails — two users can register `Alice@example.com` and `alice@example.com` as distinct accounts. New email-verified path normalises; lift the same normalisation into `registerUser`, `findUserByEmail`, OTP login, and magic-link login. Add a DB-level unique index on `lower(email)` to enforce.
- [ ] S-M20 — Refresh tokens stored in `localStorage` via `OsnAuth.setSession` (default `Storage` adapter is `localStorage`). XSS in the Pulse webview = permanent account takeover. For Tauri, swap in a keychain-backed adapter (`tauri-plugin-stronghold` or an OS-encrypted store); for web targets, prefer HttpOnly cookies issued by the auth server.
- [ ] S-M21 — `/register/begin` differential timing oracle on the silent no-op branch — when an email is already taken, the route skips the `sendEmail` call, so the response is consistently faster than the legitimate path. Add a synthetic delay or perform a dummy hash to flatten timing if/when this becomes exploitable.
- [x] S-M22 — `console.log` of OTP in dev fallback unconditionally exposed credentials in any environment without `sendEmail` set — fixed in the new registration flow: gated on `NODE_ENV !== "production"`. Login OTP and magic-link dev-log branches now also gated on `NODE_ENV !== "production"`.
- [x] S-M23 — `pendingRegistrations` Map grew unboundedly with no eviction (P-W1 / S-M2 of the security review) — fixed: capped at 10 000 entries, swept on every insert, and refuses to overwrite a non-expired entry to prevent griefing.
- [x] S-M24 — Biased modulo OTP generation (`buf[0] % 900_000` over a 32-bit draw) — fixed in the new registration flow via rejection sampling in `genOtpCode()`. Login OTP path now also uses `genOtpCode()`.
- [x] S-M25 — Non-constant-time OTP comparison via `===` — fixed in the new registration flow via `timingSafeEqualString()`. Login OTP path (`verifyOtpCode`) now also uses `timingSafeEqualString()`.
- [x] S-M26 — Differential error responses on `/register/begin` (`Email already registered` vs `Handle already taken` vs `sent: true`) leaked which accounts exist — fixed: the route now always returns `{ sent: true }` regardless of conflict status. The handle availability check via `/handle/:handle` remains the appropriate channel for that question and can be rate-limited independently.
- [x] S-M27 — `close_friends` per-row visibility filter in `pulse/api/src/services/rsvps.ts` had inverted directionality: it checked the *viewer's* close-friends list, allowing a stalker who unilaterally added a target as a close friend to see the target's gated RSVPs. Fixed by removing the `close_friends` visibility bucket entirely — close-friendship is a one-way graph edge and makes a poor access gate in either direction. Attendance visibility is `connections | no_one`; close-friend attendees are surfaced first in the returned list via the existing `isCloseFriend` display flag.
- [x] S-M28 — `getConnectionIds` / `getCloseFriendIds` in `pulse/api/src/services/graphBridge.ts` silently capped membership sets at 100, causing the visibility filter to under-permit users with larger graphs. Fixed in the full-event-view PR by raising the cap to `MAX_EVENT_GUESTS` (1000) — the platform-wide hard cap on event guest count, documented in `pulse/api/src/lib/limits.ts` and the package README. Resolves both this finding and P-W13 (same root cause).
- [x] S-M29 — No `maxLength` on `title` / `description` / `location` / `venue` / `category` in `InsertEventSchema` allowed an authenticated user to POST a 10MB description and bloat every discovery response. Fixed in the full-event-view PR with explicit caps (title 200, description 5000, location/venue 500, category 100) on both Insert and Update schemas.
- [x] S-M30 — `OTEL_EXPORTER_OTLP_HEADERS` parser tolerated malformed input (CRLF in values, spaces / colons in keys) — header smuggling risk against the OTLP collector if env vars are influenced by an attacker (compromised CI secret, misconfigured vault). Fixed: strict regex validation on both keys (`/^[A-Za-z0-9-]+$/`) and values (printable ASCII, no CR/LF); malformed input throws at `loadConfig` so misconfiguration crashes loudly at boot rather than silently smuggling headers.
- [x] S-M31 — Redaction deny-list was missing user-chosen name fields — `displayName` (the only such field that exists in the schema today) was added so it gets scrubbed alongside `email` / `handle`. Originally also added speculative entries for `firstName`, `lastName`, `fullName`, `legalName`, `dob`, `address`, `streetAddress`, `postalCode`, `ssn`, `taxId`; these were removed in the S-H21 follow-up because none of them exist as real object keys in the codebase. The deny-list is now grown only when a sensitive field actually lands in the schema/types — see the file header in `shared/observability/src/logger/redact.ts` for the criteria and the lock-step assertion in `redact.test.ts` that pins the exact set.
- [x] S-M32 — `span.recordException(error)` in the Elysia plugin wrote the error's enumerable own properties as span event attributes outside the log redactor's reach. Effect tagged errors embedding `email`, `handle`, `cause` etc. would leak to trace storage. Fixed: plugin wraps `recordException` to first scrub the error via `redact()` and only passes `name` + redacted `message` to OTel; `span.setStatus.message` is also routed through `redact()`.
- [x] S-M33 — `enrollmentToken` (and snake-case `enrollment_token`) was missing from the trimmed redaction deny-list. It is a real single-use bearer credential returned by `/register/complete` (`osn/core/src/routes/auth.ts:225`) and sent back as `Authorization: Bearer <token>` for passkey enrollment (`osn/client/src/register.ts:131,142`) — same secrecy profile as `accessToken`. Defence-in-depth (no current log path emits the completeRegistration result), but the file header criterion in `redact.ts` explicitly requires real-bearer-credential fields to be on the list. Fixed by adding both spellings to `REDACT_KEYS` under the OAuth token block, updating the lock-step assertion + positive test, and pointing at the two call sites in the comment.
- [x] S-H2 (zap) — Missing membership check on `GET /chats/:id` allowed any authenticated user to read chat metadata. Fixed: `assertMember` gate added.
- [x] S-H3 (zap) — Missing membership check on `GET /chats/:id/members` leaked member rosters. Fixed: `assertMember` gate added.
- [x] S-H4 (zap) — `PATCH /chats/:id` differentiated 403/404 for non-members, leaking chat existence. Fixed: 404 for non-members.
- [ ] S-M1 (zap) — No rate limiting on any Zap API endpoint. Add per-IP rate limiting on write endpoints (POST `/chats`, POST `/:id/messages`, POST `/:id/members`). — see [[rate-limiting]]
- [ ] S-M2 (zap) — CORS wildcard (`cors()` with no config) on `@zap/api` allows any origin. Restrict to known client origins. — see S-M6 (same pattern on Pulse)
- [ ] S-M3 (zap) — `zapBridge.provisionEventChat` does not verify caller owns the event. Add ownership check.
- [ ] S-M4 (zap) — Non-atomic cross-DB writes in `zapBridge.provisionEventChat`. Wrap Zap-side ops in transaction + add compensating logic.
- [ ] S-M5 (zap) — `addEventChatMember` does not verify chat is type "event". Add type guard.
- [ ] S-M6 (zap) — Truncated UUIDs (12 hex chars = 48 bits) reduce ID entropy. Consider using 24+ hex chars.
- [ ] S-L1 (zap) — `jwtVerify` does not restrict algorithms. Pass `{ algorithms: ['HS256'] }`. — see S-L7
- [ ] S-L2 (zap) — DM chats have no member count enforcement. Validate exactly 2 participants.
- [ ] S-L3 (zap) — Admin can remove themselves leaving chat with no admin. Check last-admin before self-removal.
- [ ] S-M43 — No rate limiting on `/graph/internal/*` S2S endpoints. ARC tokens are the primary gate, but a compromised service account could hammer graph queries without throttling. Add per-issuer rate limiter (keyed on `caller.iss`) via the existing `RateLimiterBackend` abstraction. — see [[arc-tokens]]
- [ ] S-M34 — Rate limiter trusts `X-Forwarded-For` without reverse-proxy guarantee — any client can spoof the header to bypass IP-based rate limits. Add `trustProxy` config flag or fall back to socket IP when no proxy is configured. — see [[rate-limiting]]
- [ ] S-M35 — Redirect URI allowlist matches origin only, not exact URI per OAuth 2.0 Security BCP (RFC 9700 §4.1.3). Upgrade to exact string comparison for stricter validation.
- [x] S-M36 — Async `RateLimiterBackend.check()` rejection was fail-open: unhandled rejection propagated as 500 instead of 429, bypassing rate limit counter. Fixed: `rateLimit()` and `requireRateLimit()` wrap `await check()` in try/catch, defaulting to `false` (deny) on backend errors. Fail-closed posture established before Redis backend lands.
- [x] S-M37 — `AuthRateLimiters` type was mutable, allowing post-construction limiter replacement via held reference. Fixed: type declared as `Readonly<{...}>`. Tests construct override objects via spread instead of mutation.
- [x] S-M38 — `@shared/redis` `RedisLive` logs raw connection error cause which may contain credentials from `REDIS_URL`. Fixed: `sanitizeCause()` redacts `redis://user:pass@` patterns before logging. — see [[redis]]
- [x] S-M39 — `@shared/redis` rate limiter key built from unsanitised input — namespace validated at construction (`/^[a-zA-Z0-9_:.-]+$/`), keys >256 bytes denied. — see [[redis]]
- [x] S-M40 — `@shared/redis` `RedisLive` does not enforce TLS. Fixed: logs warning when `REDIS_URL` lacks `rediss://` and `NODE_ENV=production`. — see [[redis]]
- [x] S-M41 — `createClientFromUrl()` bypassed the TLS warning established in `RedisLive` (S-M40). Fixed: `initRedisClient()` in `osn/app/src/redis.ts` checks `NODE_ENV=production` + `rediss://` and logs a warning, matching the `RedisLive` posture. — see [[redis]], [[rate-limiting]]
- [x] S-M42 — `initRedisClient()` logged raw `cause.message` on Redis connection failure, potentially leaking `REDIS_URL` credentials. Fixed: error messages are passed through `sanitizeCause()` before logging, matching the redaction in `RedisLive`. — see [[redis]]

### Low

- [ ] S-L1 — Seed data uses reserved handle `"me"` — inserted via Drizzle bypassing service layer; reveals reservation is not DB-enforced
- [ ] S-L2 — `Effect.orDie` in `requireAuth` swallows auth errors as defects — replace with `Effect.either` + explicit 401
- [ ] S-L3 — Tauri CSP is `null` — when tightened, allowlist `photon.komoot.io`, `maps.google.com`, `www.google.com`
- [ ] S-L4 — `createdByAvatar` always null — no avatar claim in JWT; populate from user profile once profiles exist
- [x] S-L5 — `getSession()` returned expired tokens — fixed
- [x] S-L6 — OTP used `Math.random()` — replaced with `crypto.getRandomValues`
- [ ] S-L7 — `jwtSecret` falls back to `"dev-secret"` — throw at startup in production
- [x] S-L8 — `getCloseFriendsOfBatch` accepted unbounded `userIds` array — fixed: clamped to `MAX_BATCH_SIZE` (1000)
- [x] S-L9 — Error objects passed to `Effect.logError` in graph wrappers could serialise verbose DB internals — fixed: `safeErrorSummary()` extracts only `_tag` + `message`
- [ ] S-L8 — OTP codes and magic link URLs logged to stdout — guard with `NODE_ENV` check
- [ ] S-L9 — `imageUrl` allows `data:` URIs — add CSP `img-src` header
- [ ] S-L10 — Sign-in page loads `@simplewebauthn/browser` from unpkg CDN without SRI hash
- [ ] S-L11 — Failed OAuth callback leaves PKCE verifier in `localStorage` — clear on state mismatch
- [ ] S-L12 — `REDIRECT_URI` derived from `window.location.origin` at runtime — prefer explicit env var
- [ ] S-L13 — PKCE `state` not validated against a stored nonce
- [x] S-L20 — `sendBlast` in `pulse/api/src/services/comms.ts` `console.log`ged the first 60 chars of every blast body to stdout in non-test envs. Blast bodies frequently contain venue codes / addresses / private details. Fixed in the full-event-view PR by removing the log entirely — tests cover the contract directly via the returned `blasts` array.
- [x] S-L21 — `serializeRsvp` in `pulse/api/src/routes/events.ts` returned `invitedByUserId` to all viewers, revealing which co-host invited each attendee on multi-organiser events. Fixed in the full-event-view PR by passing an `isOrganiser` flag through the route layer; non-organiser viewers now receive `invitedByUserId: null`.
- [ ] S-L22 — `listRsvps` counts privacy-filtered rows toward `limit`, providing a weak side-channel oracle: an attacker can vary `limit` and infer how many privacy-filtered rows exist between visible ones. Low exploitability (requires many probes; only reveals counts of an opaque population). Fix would loop until `limit` visible rows are collected. Deferred — folded into a future "stable pagination" pass on `listRsvps`.
- [x] S-L27 — `no-console` lint rule was disabled in `oxlintrc.json`. Enabled as `"warn"` in the oxlint/oxfmt upgrade branch. Existing intentional usages (DEV-gated client-side debug logging, CLI seed scripts) suppressed with inline `eslint-disable-next-line` comments.
- [ ] S-L14 — `assertion: t.Any()` on passkey register/login routes — add TypeBox shape validation for top-level WebAuthn fields
- [ ] S-L15 — No reserved-handle blocklist in DB — enforced in app layer only; consider DB-level check constraint
- [x] S-L16 — `EventList` `console.error` logs raw server error objects — guarded with `import.meta.env.DEV`
- [x] S-L17 — `displayName` returned as `undefined` in graph list responses — normalised to `null` via `userProjection()`
- [x] S-L18 — Graph rate-limit store (`rateLimitStore`) never evicts expired windows — fixed: graph route now uses shared `createRateLimiter` with proactive sweep (Redis migration Phase 1)
- [ ] S-L23 — `pkceStore` has no size bound or eviction sweep — unauthenticated `/authorize` can fill memory. Add maxEntries cap + sweepExpired.
- [ ] S-L24 — `/token` and legacy `POST /register` have no rate limiting — add per-IP limiters for consistency
- [ ] S-L19 — `jwtSecret` falls back to `"dev-secret"` in graph auth — already tracked as S-L7
- [x] S-L20 — `loadConfig` silently classified production deploys as `dev` if operators forgot to set `OSN_ENV=production` (Bun leaves `NODE_ENV` empty by default), enabling pretty-printing, 100% trace sampling, and any future dev-only code paths in prod. Fixed: `loadConfig` now throws when `OSN_ENV=production` in the environment but the resolved env differs, refusing to boot with a mismatched environment. Operators must be explicit about production classification.
- [x] S-L25 — `createRateLimiter` was exported from the `@osn/core` barrel, letting downstream consumers construct limiters with arbitrary config (e.g. `maxRequests: Infinity`) and inject them to disable rate limiting. Fixed: removed from barrel; only `RateLimiterBackend` type + default factories are public.
- [x] S-L26 — No runtime validation on injected `RateLimiterBackend` shape — a misconfigured DI object would cause `TypeError: check is not a function` at request time. Fixed: `createAuthRoutes` and `createGraphRoutes` validate every limiter slot at construction time, failing fast at boot.
- [x] S-L27 — `initRedisClient()` fail-open startup fallback weakens rate limiting in multi-replica production (each process gets independent in-memory counters). Fixed: `REDIS_REQUIRED=true` env var added — when set, process exits on Redis failure instead of falling back. Operators can choose availability vs rate-limit integrity. — see [[redis]]
- [x] S-L28 — `createClientFromUrl()` used eager ioredis connection, allowing zombie connections on health-check failure. Fixed: `lazyConnect: true` + explicit `connect()` / `disconnect()` lifecycle via `ConnectableRedisClient` interface. — see [[redis]]
- [ ] S-L29 — `/graph/internal/*` routes mounted under open CORS (`Access-Control-Allow-Origin: *`). S2S endpoints should not be browser-reachable. Restrict CORS or mount on an internal-only port. — see [[arc-tokens]]
- [ ] S-L30 — `createInternalGraphRoutes` does not accept a `loggerLayer` — ARC auth failures and route errors produce no structured log entries. Add observability layer matching `createGraphRoutes` pattern. — see [[arc-tokens]], [[observability/overview]]
- [x] S-H2 (org) — Handle enumeration via "Handle already taken" message — fixed: changed to "Handle unavailable"
- [ ] S-H1 (org) — `listMembers` service returns full `User` rows (including `email`, `id`). Route layer correctly applies `userProjection`, but service contract should restrict fields for defence-in-depth.
- [ ] S-M1 (org) — `GET /organisations/:handle/members` has no membership gate — any authenticated user can list any org's members. Add membership check or document as intentional public access.
- [x] S-M2 (org) — No `org:write` scope constant for future internal mutation endpoints — fixed: `_SCOPE_ORG_WRITE` constant added
- [ ] S-M3 (org) — `getOrganisation` service returns `ownerId` internal ID. User-facing routes project it away but future consumers may leak it.
- [x] S-L4 (org) — No `maxLength` on internal route query params — fixed: added `maxLength: 50`
- [ ] S-L1 (org) — Org creation rate limit (60/min) shared with member ops; consider tighter limit for creation specifically
- [ ] S-L3 (org) — TOCTOU gap in handle uniqueness check (DB UNIQUE constraint catches duplicates; user sees generic `DatabaseError` in race case instead of clean `OrgError`)

---

## Performance Backlog

### Critical

- [x] P-C1 — `filterByAttendeePrivacy` in `pulse/api/src/services/rsvps.ts` had an N+1 lookup against `pulse_users` (the comment claimed "batch-fetch" but the implementation did `for (id of attendeeIds) yield* getAttendanceVisibility(id)`), firing up to 200 extra queries per `listRsvps` call on busy events. Fixed in the full-event-view PR by adding `getAttendanceVisibilityBatch(userIds[])` to `pulseUsers.ts` (single `WHERE userId IN (...)` query, defaults missing keys to `connections`) and replacing the for-loop with a single call.
- [x] P-C1 (zap) — N+1 query in `listChats` fetched each chat individually in a loop. Fixed: replaced with `inArray` single query.
- [x] P-C2 (zap) — `createChat` inserted initial members one-by-one. Fixed: batch `db.insert(chatMembers).values(memberRows)`.

### Warning

- [ ] P-W1 (zap) — `listChats` returns unbounded results (no pagination). Add cursor-based pagination consistent with `listMessages`.
- [ ] P-W2 (zap) — `addMember` fetches all members to check count/duplicates. Use `COUNT(*)` + existence check or catch unique constraint violation.
- [ ] P-W3 (zap) — `provisionEventChat` non-atomic cross-DB writes — wrap Zap-side in transaction, add secondary idempotency check on `eventId`.
- [ ] P-W4 (zap) — `getChatMembers` returns all members without pagination. Add optional `limit`/`offset`.
- [x] P-W1 — `rateLimitStore` in graph routes grows without bound — fixed: graph route refactored to use shared `createRateLimiter` from `osn/core/src/lib/rate-limit.ts` which handles proactive sweeping + maxEntries cap
- [x] P-W16 — Auth rate limiter Maps swept proactively: sweep now runs on every `check()` when at least one window has elapsed since the last sweep, not just when `maxEntries` is exceeded. Deterministic memory profile in long-running processes.
- [x] P-W17 — Redirect URI allowlist pre-computed: `allowedOrigins` Set built once at boot in both `createAuthRoutes` and `createAuthService`. Per-request check is a single `Set.has()` call.
- [ ] P-W2 — `resolvePublicKey` hits DB on every scoped call despite warm cache — cache `CryptoKey` + `allowedScopes` together — see [[arc-tokens]]
- [ ] P-W3 — `sendConnectionRequest` makes two sequential independent DB reads — use `Effect.all` with `concurrency: "unbounded"`
- [ ] P-W4 — Auth Maps (`otpStore`, `magicStore`, `pkceStore`) never evict expired entries — add periodic sweep. The new `pendingRegistrations` map already uses `sweepExpired()` on insert; lift the helper into the other stores. — see [[redis]]
- [ ] P-W10 — `RegistrationClient.checkHandle` has no `AbortController` — debounced bursts of typing can leave multiple in-flight `GET /handle/:handle` requests racing each other; results are guarded against display races but the network requests still hit the DB. Plumb an `AbortSignal` through and abort the previous request when a new one is scheduled.
- [ ] P-W11 — `beginRegistration` and the legacy `registerUser` issue two parallel `findUserByEmail` + `findUserByHandle` queries instead of a single `WHERE email = ? OR handle = ?` — doubles the DB latency component on a hot signup path. Add a `findUserByEmailOrHandle` helper.
- [x] P-W16 — Missing index on `close_friends.friend_id` caused table scan in `getCloseFriendsOfBatch` and `removeConnection` cleanup — fixed: added `close_friends_friend_idx`
- [x] P-W17 — `removeConnection` and `blockUser` multi-step mutations not wrapped in a transaction — fixed: both now use `db.transaction()`
- [x] P-W18 — `@shared/redis` `wrapIoRedis` sent full Lua script body on every EVAL call. Fixed: transparent EVALSHA caching with NOSCRIPT fallback — see [[redis]]. Further improved: SHA now computed eagerly on first sight of each script (P-W2 follow-up) and EVALSHA tried first on every call.
- [x] P-W19 — `@shared/redis` `createMemoryClient` had no expiry sweep (unbounded Map growth). Fixed: proactive sweep when store exceeds `maxEntries` cap, mirroring `osn/core` rate limiter pattern — see [[redis]]
- [x] P-W20 — Double base64-decode in `requireArc` middleware (`peekIssuer` + `peekScopes` each parsed JWT payload independently). Fixed: merged into single `peekClaims()` function. — see [[arc-tokens]]
- [x] P-W21 — Unbounded `userIds` array on `POST /graph/internal/user-displays` and `POST /graph/internal/close-friends-of` — could exceed SQLite variable limit (999). Fixed: `maxItems: 200` on both TypeBox schemas. — see [[arc-tokens]]
- [ ] P-W22 — Two `Effect.runPromise` calls per internal graph request (one for ARC key resolution, one for graph query). Consolidate into single fiber when S2S throughput grows. — see [[arc-tokens]]
- [ ] P-W5 — Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes today)
- [x] P-W6 — N+1 queries in graph list functions — replaced with `inArray` batch fetches
- [x] P-W7 — `eitherBlocked` made two sequential `isBlocked` calls — collapsed to single OR query
- [x] P-W8 — `blockUser` used SELECT-then-DELETE pattern — replaced with direct `DELETE WHERE OR`
- [x] P-W9 — Eliminate extra `getEvent` round-trips in `updateEvent` — returns in-memory merged result
- [x] P-W12 — `listEvents` in `pulse/api/src/services/events.ts` clamped with `LIMIT` *before* the in-JS visibility filter, yielding unstable page sizes (the DB returned 20 rows but the JS filter could drop several private ones, leaving the client with fewer than requested) AND defeating the `events_visibility_idx` index. Fixed in the full-event-view PR by pushing the visibility filter into the SQL `WHERE` clause via `or(eq(events.visibility, "public"), eq(events.createdByUserId, viewerId))`.
- [x] P-W13 — Same root cause as S-M28: `getConnectionIds` / `getCloseFriendIds` capped at 100, silently truncating membership sets. Fixed jointly with S-M28 by raising the bound to `MAX_EVENT_GUESTS`.
- [x] P-W14 — `MapPreview` and Leaflet (~150KB + CSS) shipped on every Pulse cold start because the route, the page component, and Leaflet itself were all static imports from `App.tsx`. Fixed in the full-event-view PR with two complementary changes: (1) `EventDetailPage` and `SettingsPage` are now route-level `lazy()`-loaded in `App.tsx`, and (2) `MapPreview` itself dynamic-imports Leaflet inside `onMount` so events without coordinates never pay for the chunk at all.
- [x] P-W15 — Observability plugin had a no-op `context.with(ctxWithSpan, () => {})` call in `onRequest` that tore the activated OTel context back down immediately — the broken line made service-level `Effect.withSpan` calls root spans instead of children of the HTTP request span, breaking parent-based sampling and trace correlation. Fixed: line removed, OTel `Context` with the server span is now stashed on `REQUEST_STATE` and exposed via `getRequestContext(request)` as an explicit escape hatch for callers that want parent linkage. Documented in code why Elysia hooks cannot wrap the handler invocation via `context.with(...)` directly (separate hook invocations, not a single enclosing scope).
- [x] P-W1 (org) — Sequential queries in `createOrganisation` — fixed: parallelised handle + owner checks in single `Promise.all`
- [x] P-W2 (org) — Sequential queries in `addMember` — fixed: parallelised all four pre-insert checks
- [ ] P-W3 (org) — Sequential queries in `removeMember`/`updateMemberRole` could be parallelised (org exists + caller/target checks)
- [x] P-W4 (org) — `listUserOrganisations` two-step query — fixed: replaced with single `innerJoin` query
- [x] P-W5 (org) — `listMembers` two-step query — fixed: replaced with single `innerJoin` query
- [x] P-W6 (org) — `updateOrganisation` re-fetched org after update — fixed: constructs return from known state
- [x] P-I1 (org) — `createOrganisation` re-fetched inserted org — fixed: constructs return from known inputs

### Info

- [ ] P-I1 — `evictExpiredTokens` in `arc.ts` iterates full cache on every `getOrCreateArcToken` call — throttle or remove; `MAX_CACHE_SIZE` is sufficient
- [ ] P-I2 — `new TextEncoder()` allocated per JWT sign/verify call — cache encoded secret or import `CryptoKey` once
- [x] P-I3 — `isCloseFriendOf` used `SELECT *` with `.limit(1)` for existence check — fixed: projects only PK
- [x] P-I4 — `getCloseFriendsOfBatch` had no upper bound on `userIds` array size — fixed: clamped to `MAX_BATCH_SIZE` (1000)
- [x] P-I14 — `@shared/redis` `checkRedisHealth` timeout timer leaked on success path. Fixed: `clearTimeout` in `.finally()` — see [[redis]]
- [x] P-I15 — `@shared/redis` `RedisLive` startup ping had no timeout (indefinite hang on unresponsive Redis). Fixed: 5s timeout with `Promise.race` — see [[redis]]
- [x] P-I16 — `void Effect.runPromise(...)` fire-and-forget log statements in `initRedisClient()` could swallow observability bootstrap errors. Fixed: warning-level logs are now `await`-ed; info-level remain fire-and-forget. — see [[redis]]
- [ ] P-I5 — `/graph/internal/connections` and `/close-friends` do not expose `offset` parameter — callers cannot paginate beyond the first 100 results. Add `offset: t.Optional(t.String())` to query schema. — see [[arc-tokens]]
- [ ] P-I3 — `new TextEncoder()` allocated per `verifyPkceChallenge` call — move to module scope
- [ ] P-I4 — `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo`
- [ ] P-I5 — `completePasskeyLogin` calls `findUserByEmail` redundantly — `pk.userId` already on passkey row
- [ ] P-I6 — Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite
- [ ] P-I7 — Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *`
- [ ] P-I8 — `resolveHandle` re-fetches user from DB when handler already has the User row
- [ ] P-I9 — Graph list endpoints load entire result set before slicing — add DB-level `LIMIT`/`OFFSET` when pagination is user-facing
- [x] P-I10 — `Register.tsx` used `createEffect` to auto-skip the passkey step when WebAuthn was unsupported — fixed: skip is now imperative, called directly from `submitOtp` after the step transition. Removes the re-fire surface area and the `!busy()` infinite-loop guard.
- [x] P-I11 — `Register.tsx` wrapped `detailsValid` in `createMemo` for a 3-line boolean expression — fixed: inlined as a plain accessor function. Solid's reactivity already re-runs JSX accessors fine-grainedly; the memo node was pure overhead.
- [x] P-I12 — `Register.tsx` reallocated the `RegistrationClient` (and its closures) on every component mount — fixed: hoisted to module scope.
- [ ] P-I13 — `upsertRsvp` calls `ensurePulseUser(userId)` even on the update branch (the row must already exist for the user to have an RSVP). Folded into the full-event-view PR's RSVP rewrite — `ensurePulseUser` now only runs on the insert branch, saving one round-trip per RSVP update. Tracking here for posterity. **Already fixed; this entry is documentation.**
- [ ] P-I14 — `GET /events/:id/ics` in `pulse/api/src/routes/events.ts` has no `Cache-Control` / `ETag` headers despite the response being a pure function of `event.id` + `event.updatedAt`. Calendar clients re-poll the URL on a schedule and would benefit from `If-None-Match` revalidation. Deferred — quality-of-life, not a hot path.
- [ ] P-I15 — `rsvpCounts` in `pulse/api/src/services/rsvps.ts` calls `loadEvent(eventId)` purely to produce a 404 signal. The route already gates the event via `loadVisibleEvent` upstream, so the second `loadEvent` is redundant on every counts request. Deferred — minor cleanup, the defensive 404 is cheap.
- [x] P-I16 — `redact()` unconditionally walked every log payload even for scalar messages (primitive fast path missed) — allocated a fresh WeakSet on every call. Fixed: primitives (`null`, `undefined`, scalars, `Date`) return immediately without allocating or walking.
- [x] P-I17 — `listEvents` / `listTodayEvents` used `Effect.forEach(..., { concurrency: "unbounded" })` over `applyTransition`, fanning out up to 100 in-flight DB UPDATEs + 100 child spans per list response. Fixed: bounded concurrency to 5 — enough parallelism to hide round-trip latency without unleashing a burst against the SQLite writer. (Still worth batching the UPDATEs themselves into a single `WHERE id IN (...)` query — tracked as part of pre-existing P-W5.)
- [x] P-I18 — `instrumentedFetch` allocated a fresh `Headers` instance + spread `init` on every outbound call even when the caller had already passed a `Headers` object. Fixed: reuse the caller's Headers instance in place when it's already a Headers object; only allocate when the caller passed a plain record.

---

## Deferred Decisions

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| Signal vs MLS for Zap group chats — see [[zap]] | Sender-keys is simpler; MLS scales past ~50 members | Before Zap M2 |
| Zap media storage (images / voice / video) | Needs E2E-friendly blob storage; SQLite-only won't cut it | When Zap M2 lands |
| Effect.ts adoption | Trial underway in `pulse/api` | After more service coverage |
| Supabase migration | Currently SQLite | When scaling needed |
| Android support | iOS priority | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | 15–20 attendees auto-finish; host notified | When attendee/messaging features land |
| Max event duration | Prompt user when creating events without endTime | When Pulse event creation UI is built |
| Redis provider — see [[redis]] | Upstash (serverless, free tier) vs Redis Cloud vs self-hosted. Upstash aligns with serverless deploy model; Cloudflare Durable Objects reconsidered if deploying to Workers. | When deploying beyond localhost |
| S2S scaling — see [[s2s-patterns]], [[arc-tokens]], [[s2s-migration]] | Current: direct package import (`createGraphService()`). Migrate to HTTP `/graph/internal/*` + ARC tokens when scaling horizontally. | When multi-process or multi-machine deployment needed |
| Per-app blocking — see [[social-graph]] | Blocks are global across all OSN apps. Per-app scope deferred. | When Messaging or a third-party app needs independent block lists |
| Tauri passkey support on iOS | Tauri webview does not expose WebAuthn natively — `pulse/app` registration flow (rendered by `@osn/ui/auth/Register`) feature-detects via `browserSupportsWebAuthn()` and auto-skips the passkey step on unsupported environments. Options when we ship mobile: (a) adopt [`tauri-plugin-webauthn`](https://github.com/Profiidev/tauri-plugin-webauthn) (third-party, audit first), (b) write our own thin Tauri plugin wrapping `ASAuthorizationPlatformPublicKeyCredentialProvider`, (c) wait for upstream — track [tauri#7926](https://github.com/tauri-apps/tauri/issues/7926). | When iOS build of Pulse is ready for sign-in |

---

## Future

### Phase 2: Polish
- [ ] Advanced discovery algorithms
- [ ] Venue pages with DJ schedules
- [ ] Recurring event management UI
- [ ] Calendar integration improvements
- [ ] Accessibility audit

### Phase 3: Expansion
- [ ] Social media platform (spec exists, implementation deferred)
- [ ] Android support
- [ ] Self-hosting capabilities
- [ ] Third-party API ecosystem
- [ ] Supabase migration (from SQLite)
