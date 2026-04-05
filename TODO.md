# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

`@osn/core` — full OIDC-style auth server (passkey, OTP, magic-link, PKCE, JWT, OIDC discovery) + complete social graph service + HTTP routes (connections, close friends, blocks) with rate limiting, input validation, pagination, N+1-free list queries, and safe error responses. `@osn/db` — users + passkeys + social graph schema. `apps/osn` — auth + graph server on port 4000. `apps/pulse` — full event CRUD UI (59 component tests), location autocomplete, Maps button, toast, double-click guard. `@pulse/db` — lat/lng + dynamic seed. `@osn/api` — events domain with coordinate range validation. 127 tests passing across 12 files.

---

## Up Next

Highest-priority items across all areas.

- [x] OSN Core: social graph data model (connections, close friends, blocks)
- [x] Pulse: toast notification system (solid-toast)
- [ ] Platform: ARC tokens — implement `@osn/crypto` arc module + `service_accounts` table (first consumer: Pulse API → OSN Core)
- [ ] Pulse: "What's on today" default view
- [ ] Landing page: design and content
- [ ] Security: fix open redirect in `/magic/verify` before any deployment — H3
- [ ] Security: make PKCE mandatory at `/token` — H4

---

## Pulse (`apps/pulse`)

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
- [x] Coordinate storage (lat/lng from Photon autocomplete) + Maps button on EventCard
- [ ] Map preview in expanded event view (Leaflet + OpenStreetMap, no API key)
- [ ] "What's on today" default view
- [ ] Prompt for max event duration when creating events without an endTime
- [ ] Event discovery (location, category, datetime, friends, interests)
- [ ] Recurring events (series + instances)
- [ ] Event group chats (via messaging backend)
- [ ] Calendar view + iCal export
- [ ] Hidden attendance option
- [ ] Organizer tools (moderation, blacklists)
- [ ] Venue pages

---

## OSN Core (`apps/osn` + `packages/core`)

- [x] OAuth/OIDC provider (passkey, OTP, magic link, PKCE, JWT) in `@osn/core`
- [x] User registration/login flows
- [x] `apps/osn` auth server entry point (port 4000)
- [x] 50 tests: services, routes, lib/crypto, lib/html
- [x] Social graph data model (connections, close friends, blocks) — 124 tests
- [ ] ARC token verification middleware on internal graph routes (`/graph/internal/*`)
- [ ] Per-app vs global blocking logic (deferred — global blocking across all OSN apps for now)
- [ ] Interest profile selection (onboarding)
- [ ] Third-party app authorization flow

---

## Messaging (`apps/messaging`)

- [ ] Initialize Tauri app (`bunx tauri init`)
- [ ] Signal protocol research/implementation (`packages/crypto`)
- [ ] Direct/indirect mode architecture
- [ ] DM functionality
- [ ] Group chats
- [ ] Event chat linking (show event overview in settings)
- [ ] Backup options (cloud, self-hosted, local)
- [ ] Device transfer

---

## Landing (`apps/landing`)

- [x] Astro + Solid scaffolding
- [ ] Design and build landing page content
- [ ] Deploy (Vercel/Cloudflare)

---

## Platform

### API (`packages/api`)

- [x] Elysia setup + Eden client
- [x] Effect.ts trial integration
- [x] Events domain (list, today, get, create, update, delete) — 47 tests
- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (currently N individual writes)
- [ ] Eliminate extra `getEvent` round-trips in `createEvent`/`updateEvent` via `RETURNING *`
- [ ] S2S graph access: add `@osn/core` + `@osn/db` deps; use `createGraphService()` read-only for event filtering (`hideBlocked`, `onlyConnections`) — first ARC token consumer
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`packages/osn-db`, `packages/pulse-db`)

- [x] Per-app DB packages (osn-db, pulse-db)
- [x] Pulse: events schema, migrations, smoke tests
- [x] OSN Core: users + passkeys schema, migration, smoke tests
- [x] OSN Core: social graph schema (connections, close_friends, blocks)
- [ ] OSN Core: `service_accounts` table — `service_id`, `public_key_jwk`, `allowed_scopes` (for ARC token verification)
- [ ] OSN Core: session schema (JWT-based for now; DB storage deferred)
- [ ] Pulse: event series schema
- [ ] Pulse: chat/message schema (via messaging backend)
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema

### Auth Client (`packages/client`)

- [x] Eden client wrapper
- [x] `getSession()` with expiry check
- [x] `AuthProvider` + `handleCallback` for SolidJS
- [x] 10 tests

### Crypto (`packages/crypto`)

ARC = OSN's ASAP-style service-to-service (S2S) auth token. ES256 (ECDSA), short-lived (5 min), cached in-memory until 30s before expiry. Self-issued by the calling service, verified by the receiver using the caller's public key (looked up from `service_accounts` table or a JWKS URL for third-party apps). Scope-gated (`graph:read`, `graph:write`, etc.).

- [ ] `generateArcKeyPair()` — ES256 keypair generation
- [ ] `createArcToken(privateKey, { iss, aud, scope, ttl? })` — signs and returns a short-lived JWT
- [ ] `verifyArcToken(token, publicKey)` — verifies signature, expiry, audience
- [ ] `resolvePublicKey(iss)` — looks up public key from `service_accounts` table or JWKS URL (for third-party apps)
- [ ] In-memory token cache with 30s-before-expiry eviction

### UI Components (`packages/ui`)

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

---

## Security Backlog

Address **High** items before any non-local deployment.

### High
- [ ] Open redirect in `/magic/verify`: `redirect_uri` not validated against an allowlist — attacker can steal auth codes — H3
- [ ] PKCE check optional at `/token`: silently skipped when `state` absent — make mandatory per RFC 7636 — H4
- [x] No auth/authorisation middleware on API routes (OWASP A01) — H1 (POST/PATCH/DELETE require auth; unauthenticated → 401)
- [x] No ownership check on mutating event operations (create/update/delete) — H2 (createdByUserId NOT NULL; 403 on non-owner)

### Medium
- [ ] `POST /register` has no rate limiting or email verification — handles can be squatted in bulk; add per-IP rate limit and email confirmation before first login — M13
- [ ] `displayName` is embedded in JWT access tokens (1 h TTL) — stale after a profile update; `createdByName` on events reflects the old value until token expires — M14
- [ ] Wildcard CORS on auth server — restrict to known client origins before deployment — M3
- [ ] No OTP attempt limit — 6-digit codes brute-forceable at HTTP speeds — M8
- [ ] All auth state in process memory (`otpStore`, `magicStore`, `pkceStore`, etc.) — lost on restart, unsafe for multi-process — M6
- [ ] `redirect_uri` at `/token` not matched against value stored in `pkceStore` during `/authorize` (RFC 6749 §4.1.3) — M10
- [ ] `/passkey/register/begin` accepts arbitrary `userId` with no auth check — M11
- [ ] Magic-link tokens use `crypto.randomUUID` without additional entropy hardening — M7
- [x] `limit` query param in `listEvents` uncapped — guard `NaN` and clamp to 1–100 — M2 (clamped in service layer)
- [ ] Photon (Komoot) geocoding: keystrokes sent to third-party with no user notice — add consent UI or proxy — M1
- [ ] Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side in `@osn/core`; already tracked as H3 — M12

### Low
- [ ] Tauri CSP is `null` — when tightened, allowlist `photon.komoot.io` (geocoding fetch) and `maps.google.com` / `www.google.com` (Maps links) — L7
- [ ] `createdByAvatar` is always null — no avatar claim in JWT; populate from user profile record once user profiles exist — L8-pulse
- [x] `getSession()` returned expired tokens — fixed
- [x] OTP used `Math.random()` — replaced with `crypto.getRandomValues`
- [ ] `jwtSecret` falls back to `"dev-secret"` — throw at startup in production — M9
- [ ] OTP codes and magic link URLs logged to stdout — guard with `NODE_ENV` check — L5
- [ ] `imageUrl` allows `data:` URIs — add CSP `img-src` header — L1
- [ ] Sign-in page loads `@simplewebauthn/browser` from unpkg CDN without SRI hash — L6
- [ ] Failed OAuth callback leaves PKCE verifier in `localStorage` — clear on state mismatch — L2
- [ ] `REDIRECT_URI` derived from `window.location.origin` at runtime — prefer explicit env var — L3
- [ ] PKCE `state` not validated against a stored nonce — L4
- [ ] `jose` and `@simplewebauthn/server` use caret version ranges — pin to exact versions — L7
- [ ] Pulse `auth.ts` exports only public/build-time config — add comment discouraging secrets in that file — L8
- [ ] `assertion: t.Any()` on passkey register/login routes — add lightweight TypeBox shape validation for top-level WebAuthn fields (`id`, `rawId`, `response`, `type`) — L10
- [ ] No reserved-handle blocklist in DB — currently enforced in app layer only (`RESERVED_HANDLES` set in `@osn/core`); consider a DB-level check constraint or migration-managed table — L11
- [x] `EventList` `console.error` logs raw server error objects — guarded with `import.meta.env.DEV` — L9
- ~~`@vitest/coverage-istanbul` uses caret version range — L10~~ dismissed: caret ranges are the project standard
- [x] Graph GET endpoints unguarded — all GET handlers now wrapped in try/catch; generic "Request failed" on unexpected errors — H2-graph (fixed in feat/social-graph-data-model)
- [x] `is-blocked` route used `eitherBlocked`, leaking whether target had blocked caller — route now uses `isBlocked(caller, target)` only — M1-graph (fixed in feat/social-graph-data-model)
- [x] No rate limiting on graph write endpoints — module-level fixed-window limiter added (60/user/min) — M2-graph (fixed in feat/social-graph-data-model)
- [x] Raw DB/Effect errors surfaced in graph responses — `safeError()` helper added; only `GraphError`/`NotFoundError` messages exposed — M3-graph (fixed in feat/social-graph-data-model)
- [x] No input validation on `:handle` route param in graph routes — TypeBox `HandleParam` with regex `^[a-z0-9_]+$` + length bounds added — M4-graph (fixed in feat/social-graph-data-model)
- [ ] Graph rate-limit store (`rateLimitStore`) never evicts expired windows — same eviction gap as auth stores; add periodic sweep — L12-graph
- [x] `displayName` returned as `undefined` in graph list responses when absent — normalised to `null` via `userProjection()` — L3-graph (fixed in feat/social-graph-data-model)
- [ ] `jwtSecret` falls back to `"dev-secret"` in graph auth (pre-existing from auth service) — throw at startup in production — already tracked as M9

---

## Performance Backlog

- [ ] Auth Maps (`otpStore`, `magicStore`, `pkceStore`, etc.) never evict expired entries — add periodic sweep — P1
- [ ] `new TextEncoder()` allocated per JWT sign/verify call — cache encoded secret or import `CryptoKey` once — P2
- [ ] `new TextEncoder()` allocated per `verifyPkceChallenge` call — move to module scope — P3
- [ ] `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo` — P4
- [ ] `completePasskeyLogin` calls `findUserByEmail` redundantly — `pk.userId` already on passkey row — P5
- [ ] Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite; explicit `users_email_idx` is redundant (pre-existing; handle_idx removed in feat/user-handle-system) — P6
- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes today) — P7
- [x] Eliminate extra `getEvent` round-trips in `updateEvent` — P8 (returns in-memory merged result; applyTransition called locally)
- [ ] Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *` — P9
- [ ] Add index on `created_by_user_id` in pulse-db events — done in feat/event-ownership; move to done once merged
- [x] N+1 queries in graph list functions — replaced with `inArray` batch fetches — P1-graph (fixed in feat/social-graph-data-model)
- [x] `eitherBlocked` made two sequential `isBlocked` calls — collapsed to single OR query — P2-graph (fixed in feat/social-graph-data-model)
- [x] `blockUser` used SELECT-then-DELETE pattern — replaced with direct `DELETE WHERE OR` — P3-graph (fixed in feat/social-graph-data-model)
- [ ] `resolveHandle` re-fetches user from DB even when the handler already has the User row — minor; consolidate once graph routes grow — P10-graph
- [ ] Graph list endpoints load entire result set before slicing — add DB-level `LIMIT`/`OFFSET` once pagination is a user-facing concern — P11-graph (low priority; clamped to 100 rows today)

---

## Deferred Decisions

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Messaging app name | Need a catchy name | Before public launch |
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| Effect.ts adoption | Trial underway in `packages/api` | After more service coverage |
| Supabase migration | Currently SQLite | When scaling needed |
| Android support | iOS priority | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | 15–20 attendees auto-finish; host notified | When attendee/messaging features land |
| Max event duration | Prompt user when creating events without endTime | When Pulse event creation UI is built |
| S2S scaling: HTTP graph API | Current approach is direct package import (`createGraphService()`) — zero network overhead, Pulse API reads `osn.db` read-only. When horizontal scaling is needed, migrate to HTTP `/graph/internal/*` endpoints verified via ARC tokens. | When multi-process or multi-machine deployment needed |
| Per-app blocking | Currently blocks are global across all OSN apps. Per-app scope deferred. | When Messaging or a third-party app needs independent block lists |

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
