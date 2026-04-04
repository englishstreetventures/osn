# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

`@osn/core` — full OIDC-style auth server: passkey (WebAuthn), OTP, magic-link, PKCE, JWT, OIDC discovery. `@osn/db` — users + passkeys schema. `apps/osn` — auth server entry point on port 4000. `@osn/client` — session expiry check, `handleCallback`. `apps/pulse` — auth callback handler, event CRUD UI, location autocomplete (with coordinate capture), Maps button on EventCard, toast notifications (solid-toast), double-click guard on delete; 59 component tests. `@pulse/db` — lat/lng columns + dynamic seed data. `@osn/api` — events domain fully tested with coordinate range validation. 119 tests passing across 10 files.

---

## Up Next

Highest-priority items across all areas.

- [ ] OSN Core: social graph data model (connections, close friends, blocks)
- [x] Pulse: toast notification system (solid-toast)
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
- [ ] Social graph data model (connections, close friends, blocks)
- [ ] Per-app vs global blocking logic
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
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`packages/osn-db`, `packages/pulse-db`)

- [x] Per-app DB packages (osn-db, pulse-db)
- [x] Pulse: events schema, migrations, smoke tests
- [x] OSN Core: users + passkeys schema, migration, smoke tests
- [ ] OSN Core: social graph schema (connections, blocks)
- [ ] OSN Core: session schema (JWT-based for now; DB storage deferred)
- [ ] Pulse: event series schema
- [ ] Pulse: chat/message schema (via messaging backend)
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema

### Auth Client (`packages/client`)

- [x] Eden client wrapper
- [x] `getSession()` with expiry check
- [x] `AuthProvider` + `handleCallback` for SolidJS
- [x] 10 tests

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
- [x] `EventList` `console.error` logs raw server error objects — guarded with `import.meta.env.DEV` — L9
- ~~`@vitest/coverage-istanbul` uses caret version range — L10~~ dismissed: caret ranges are the project standard

---

## Performance Backlog

- [ ] Auth Maps (`otpStore`, `magicStore`, `pkceStore`, etc.) never evict expired entries — add periodic sweep — P1
- [ ] `new TextEncoder()` allocated per JWT sign/verify call — cache encoded secret or import `CryptoKey` once — P2
- [ ] `new TextEncoder()` allocated per `verifyPkceChallenge` call — move to module scope — P3
- [ ] `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo` — P4
- [ ] `completePasskeyLogin` calls `findUserByEmail` redundantly — `pk.userId` already on passkey row — P5
- [ ] Duplicate index on `users.email` — `unique()` already creates one implicitly — P6
- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes today) — P7
- [x] Eliminate extra `getEvent` round-trips in `updateEvent` — P8 (returns in-memory merged result; applyTransition called locally)
- [ ] Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *` — P9
- [ ] Add index on `created_by_user_id` in pulse-db events — done in feat/event-ownership; move to done once merged

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
