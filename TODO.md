# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Up Next

- [ ] Pulse: "What's on today" default view
- [ ] Landing page: design and content
- [ ] S-H3 — Open redirect in `/magic/verify` — fix before any deployment
- [ ] S-H4 — Make PKCE mandatory at `/token`
- [ ] S-H1 — Rate limit `POST /register`
- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — grace period needed
- [ ] ARC token verification middleware on internal graph routes (`/graph/internal/*`)

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
- [x] Handle system — registration, real-time availability check, email/handle sign-in toggle
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
- [x] OSN Core: `service_accounts` table — `service_id`, `public_key_jwk`, `allowed_scopes` (for ARC token verification)
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

- [x] `generateArcKeyPair()` — ES256 keypair generation
- [x] `createArcToken(privateKey, { iss, aud, scope, ttl? })` — signs and returns a short-lived JWT
- [x] `verifyArcToken(token, publicKey)` — verifies signature, expiry, audience, scope
- [x] `resolvePublicKey(iss)` — looks up public key from `service_accounts` table (Effect-based, requires Db)
- [x] In-memory token cache with 30s-before-expiry eviction (`getOrCreateArcToken`)
- [x] Key import/export utilities (`exportKeyToJwk`, `importKeyFromJwk`)
- [ ] JWKS URL fallback in `resolvePublicKey` for third-party apps

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
- [x] Claude skills: review-security, review-performance, review-tests, prep-pr, review-deps
- [x] UserPromptSubmit hook for tone enforcement

---

## Security Backlog

Address **High** items before any non-local deployment.

### High

- [ ] S-H1 — `POST /register` no rate limit — handles squattable in bulk; add per-IP rate limit (urgency increased: now user-facing via "Create account" tab)
- [ ] S-H2 — `GET /handle/:handle` no rate limit — handle namespace fully enumerable at HTTP speeds; add 10 req/IP/min limit
- [ ] S-H3 — Open redirect in `/magic/verify`: `redirect_uri` not validated against allowlist — attacker can steal auth codes (three call sites: magic verify + registration OTP verify path)
- [ ] S-H4 — PKCE check optional at `/token`: silently skipped when `state` absent — make mandatory per RFC 7636
- [ ] S-H5 — `/passkey/register/begin` accepts arbitrary `userId` with no auth check — combined with fresh `userId` returned pre-email-verification, enables account pre-hijacking; require verified session/code before accepting passkey registration
- [x] S-H6 — No auth/authorisation middleware on API routes (OWASP A01) — POST/PATCH/DELETE require auth; unauthenticated → 401
- [x] S-H7 — No ownership check on mutating event operations — createdByUserId NOT NULL; 403 on non-owner
- [x] S-H8 — Graph GET endpoints unguarded — all GET handlers wrapped in try/catch; generic "Request failed" on unexpected errors

### Medium

- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — old tokens 401 silently; treat missing `handle` as `null` during transition period
- [ ] S-M2 — In-memory rate limiter resets on restart/deploy — document as known; migrate to shared counter when scaling horizontally
- [ ] S-M3 — No "resend code" button after registration OTP; if SMTP fails, handle/email are claimed with no recovery path
- [ ] S-M4 — `POST /register` returns raw `String(catch)` error — can expose Drizzle constraint internals; normalise to user-safe strings
- [ ] S-M5 — `displayName` embedded in JWT (1h TTL) — stale after profile update; `createdByName` on events reflects old value until token expires
- [ ] S-M6 — Wildcard CORS on auth server — restrict to known client origins before deployment
- [ ] S-M7 — No OTP attempt limit — 6-digit codes brute-forceable at HTTP speeds
- [ ] S-M8 — All auth state in process memory (`otpStore`, `magicStore`, `pkceStore`) — lost on restart, unsafe for multi-process
- [ ] S-M9 — `redirect_uri` at `/token` not matched against value stored in `pkceStore` during `/authorize` (RFC 6749 §4.1.3)
- [ ] S-M10 — `/passkey/register/begin` accepts arbitrary `userId` with no auth check (elevated to S-H5; see High section)
- [ ] S-M11 — Magic-link tokens use `crypto.randomUUID` without additional entropy hardening
- [x] S-M12 — `limit` query param in `listEvents` uncapped — clamped to 1–100 in service layer
- [ ] S-M13 — Photon (Komoot) geocoding: keystrokes sent to third-party with no user notice — add consent UI or proxy
- [ ] S-M14 — Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side; tracked as S-H3
- [x] S-M15 — `is-blocked` route leaked whether target had blocked caller — route now uses `isBlocked(caller, target)` only
- [x] S-M16 — No rate limiting on graph write endpoints — module-level fixed-window limiter added (60/user/min)
- [x] S-M17 — Raw DB/Effect errors surfaced in graph responses — `safeError()` helper; only `GraphError`/`NotFoundError` messages exposed
- [x] S-M18 — No input validation on `:handle` route param in graph routes — TypeBox `HandleParam` with regex + length bounds added

### Low

- [ ] S-L1 — Seed data uses reserved handle `"me"` — inserted via Drizzle bypassing service layer; reveals reservation is not DB-enforced
- [ ] S-L2 — `Effect.orDie` in `requireAuth` swallows auth errors as defects — replace with `Effect.either` + explicit 401
- [ ] S-L3 — Tauri CSP is `null` — when tightened, allowlist `photon.komoot.io`, `maps.google.com`, `www.google.com`
- [ ] S-L4 — `createdByAvatar` always null — no avatar claim in JWT; populate from user profile once profiles exist
- [x] S-L5 — `getSession()` returned expired tokens — fixed
- [x] S-L6 — OTP used `Math.random()` — replaced with `crypto.getRandomValues`
- [ ] S-L7 — `jwtSecret` falls back to `"dev-secret"` — throw at startup in production
- [ ] S-L8 — OTP codes and magic link URLs logged to stdout — guard with `NODE_ENV` check
- [ ] S-L9 — `imageUrl` allows `data:` URIs — add CSP `img-src` header
- [ ] S-L10 — Sign-in page loads `@simplewebauthn/browser` from unpkg CDN without SRI hash
- [ ] S-L11 — Failed OAuth callback leaves PKCE verifier in `localStorage` — clear on state mismatch
- [ ] S-L12 — `REDIRECT_URI` derived from `window.location.origin` at runtime — prefer explicit env var
- [ ] S-L13 — PKCE `state` not validated against a stored nonce
- [ ] S-L14 — `assertion: t.Any()` on passkey register/login routes — add TypeBox shape validation for top-level WebAuthn fields
- [ ] S-L15 — No reserved-handle blocklist in DB — enforced in app layer only; consider DB-level check constraint
- [x] S-L16 — `EventList` `console.error` logs raw server error objects — guarded with `import.meta.env.DEV`
- [x] S-L17 — `displayName` returned as `undefined` in graph list responses — normalised to `null` via `userProjection()`
- [ ] S-L18 — Graph rate-limit store (`rateLimitStore`) never evicts expired windows — add periodic sweep
- [ ] S-L19 — `jwtSecret` falls back to `"dev-secret"` in graph auth — already tracked as S-L7

---

## Performance Backlog

### Warning

- [ ] P-W1 — `rateLimitStore` in graph routes grows without bound — expired entries never evicted; add `setInterval` sweep
- [ ] P-W2 — `resolvePublicKey` hits DB on every scoped call despite warm cache — cache `CryptoKey` + `allowedScopes` together
- [ ] P-W3 — `sendConnectionRequest` makes two sequential independent DB reads — use `Effect.all` with `concurrency: "unbounded"`
- [ ] P-W4 — Auth Maps (`otpStore`, `magicStore`, `pkceStore`) never evict expired entries — add periodic sweep
- [ ] P-W5 — Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes today)
- [x] P-W6 — N+1 queries in graph list functions — replaced with `inArray` batch fetches
- [x] P-W7 — `eitherBlocked` made two sequential `isBlocked` calls — collapsed to single OR query
- [x] P-W8 — `blockUser` used SELECT-then-DELETE pattern — replaced with direct `DELETE WHERE OR`
- [x] P-W9 — Eliminate extra `getEvent` round-trips in `updateEvent` — returns in-memory merged result

### Info

- [ ] P-I1 — `evictExpiredTokens` in `arc.ts` iterates full cache on every `getOrCreateArcToken` call — throttle or remove; `MAX_CACHE_SIZE` is sufficient
- [ ] P-I2 — `new TextEncoder()` allocated per JWT sign/verify call — cache encoded secret or import `CryptoKey` once
- [ ] P-I3 — `new TextEncoder()` allocated per `verifyPkceChallenge` call — move to module scope
- [ ] P-I4 — `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo`
- [ ] P-I5 — `completePasskeyLogin` calls `findUserByEmail` redundantly — `pk.userId` already on passkey row
- [ ] P-I6 — Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite
- [ ] P-I7 — Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *`
- [ ] P-I8 — `resolveHandle` re-fetches user from DB when handler already has the User row
- [ ] P-I9 — Graph list endpoints load entire result set before slicing — add DB-level `LIMIT`/`OFFSET` when pagination is user-facing

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
| S2S scaling: HTTP graph API | Current: direct package import (`createGraphService()`). Migrate to HTTP `/graph/internal/*` + ARC tokens when scaling horizontally. | When multi-process or multi-machine deployment needed |
| Per-app blocking | Blocks are global across all OSN apps. Per-app scope deferred. | When Messaging or a third-party app needs independent block lists |

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
