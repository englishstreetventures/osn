# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Events API fully operational with Effect.ts service pattern and test coverage. Pulse backend has complete CRUD for events (list, today, get, create, update, delete) with Effect Schema validation and proper error types. 29 tests cover service layer (Effect) and HTTP routes (integration). Frontend surfaces events via Eden client. DB split into `@osn/db` (OSN Core, placeholder) and `@pulse/db` (Pulse events). Ready to build out event discovery, lifecycle transitions, and the Pulse UI.

---

## Deferred Decisions

Decisions to revisit later. Add new items as they come up.

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Messaging app name | Need a catchy name | Before public launch |
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| Effect.ts adoption | Trial underway in `packages/api` (events service complete) | After more service coverage |
| Supabase migration | Currently SQLite for simplicity | When scaling needed |
| Android support | iOS priority for now | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | When 15–20 attendees report an event as ended, auto-finish it; host gets push notification to mark it finished | When attendee/messaging features land |
| Max event duration | Frontend should prompt for a max auto-finish duration (e.g. 4h) when creating events without an endTime | When Pulse event creation UI is built |

---

## Phase 1: Foundation

### Infrastructure
- [x] Turborepo setup
- [x] Changesets for versioning
- [x] Shared TypeScript configs
- [x] Package structure (api, db, ui, core, crypto)
- [x] CI/CD pipeline (GitHub Actions)
- [x] Linting/formatting in CI
- [x] oxlint configuration (`oxlintrc.json` - React disabled, SolidJS compatible)
- [x] lefthook pre-commit/pre-push hooks
- [x] Claude Code GitHub integration (@claude mentions, PR reviews)
- [x] Automated security review on PRs
- [x] Vitest + @effect/vitest test setup (packages/api, packages/db)

### Landing Page (`apps/landing`)
- [x] Astro + Solid scaffolding
- [ ] Design and build landing page content
- [ ] Deploy (Vercel/Cloudflare)

### OSN Core (`apps/osn`)
- [ ] Initialize Tauri app (`bunx tauri init`)
- [ ] OAuth/OIDC provider implementation
- [ ] User registration/login
- [ ] Social graph data model (connections, close friends, blocks)
- [ ] Per-app vs global blocking logic
- [ ] Interest profile selection (onboarding)
- [ ] Third-party app authorization flow

### Pulse (`apps/pulse`)
- [x] Initialize Tauri app with SolidJS (`bunx create-tauri-app`)
- [x] iOS target configured (`bunx tauri ios init`)
- [x] Event data model and schema
- [x] Event CRUD operations (list, today, get, create, update, delete)
- [x] Events surfaced to frontend via Eden client
- [x] Event lifecycle auto-transitions (on-read, no background job)
- [x] Event CRUD UI (create form, delete, Eden client, shadcn tokens)
- [x] Vitest setup + utils tests (formatTime, toDatetimeLocal, composeLabel)
- [ ] Component tests for `LocationInput` debounce/abort logic and `CreateEventForm` end-time validation (needs jsdom/browser test setup)
- [ ] Frontend UX: prompt for max event duration when creating events without an endTime
- [ ] Add toast notification system (errors, warnings, info) — errors currently only logged to console or silently dropped
- [ ] Event discovery (location, category, datetime, friends, interests)
- [ ] "What's on today" default view
- [ ] Recurring events (series + instances)
- [ ] Event group chats (via messaging backend)
- [ ] Calendar view
- [ ] iCal export
- [ ] Hidden attendance option
- [ ] Organizer tools (moderation, blacklists)
- [ ] Venue pages

### Messaging (`apps/messaging`)
- [ ] Initialize Tauri app (`bunx tauri init`)
- [ ] Signal protocol research/implementation (`packages/crypto`)
- [ ] Direct/indirect mode architecture
- [ ] DM functionality
- [ ] Group chats
- [ ] Event chat linking (show event overview in settings)
- [ ] Backup options (cloud, self-hosted, local)
- [ ] Device transfer

### Backend (`packages/api`)
- [x] Basic Elysia setup
- [x] Eden client export
- [x] Effect.ts trial integration (events service)
- [x] Events domain module (list, today, get, create, update, delete)
- [x] Service + route tests (Vitest, 44 tests)
- [ ] HTTP-level test for `GET /events?category=<value>` (service layer covered, route wiring untested)
- [ ] HTTP-level 422 test for `PATCH /events/:id` with invalid `startTime`/`endTime`
- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (currently N individual writes — W1)
- [ ] Eliminate extra `getEvent` round-trips in `createEvent`/`updateEvent` via `RETURNING *` — W2
- [ ] Add indexes on `status` and `category` columns in `pulse-db` events schema — I1
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Security (follow-up PR)
- [ ] Add authentication/authorisation middleware to all API routes (OWASP A01) — H1
- [ ] Add ownership model to mutating event operations (create/update/delete) — H2
- [ ] Evaluate Photon (Komoot) geocoding privacy: keystrokes sent to third-party with no user notice — add consent UI or proxy — M1
- [ ] Cap `limit` query parameter in `listEvents` (min 1, max 100) and guard `NaN` → no-limit fallback — M2
- [ ] Lock down CORS `origin` before any non-local deployment — M3
- [ ] `getSession()` returns expired tokens without checking `expiresAt` — add expiry check + silent refresh — M4
- [ ] `imageUrl` allows `data:` URIs; add CSP `img-src` header — L1
- [ ] Failed OAuth callback leaves PKCE verifier in `localStorage` — clear on state mismatch — L2
- [ ] `REDIRECT_URI` derived from `window.location.origin` at runtime — prefer explicit env var — L3

### Database (`packages/osn-db` → `@osn/db`, `packages/pulse-db` → `@pulse/db`)
- [x] Split DB into per-app packages (osn-db, pulse-db)
- [x] Pulse: Drizzle + SQLite setup, event schema, migrations, schema smoke tests (3 tests)
- [ ] OSN Core: User schema (users, passkey credentials)
- [ ] OSN Core: Session schema (sessions, refresh tokens)
- [ ] OSN Core: Social graph schema (connections, blocks)
- [ ] Pulse: Event series schema
- [ ] Pulse: Chat/Message schema (via messaging backend)

### UI Components (`packages/ui`)
- [ ] Design system / tokens
- [ ] Button, Input, Card basics
- [ ] Chat interface (shared between Pulse and Messaging)
- [ ] Event card component
- [ ] Calendar component

---

## Phase 2: Polish

- [ ] Advanced discovery algorithms
- [ ] Venue pages with DJ schedules
- [ ] Recurring event management UI
- [ ] Calendar integration improvements
- [ ] Performance optimization
- [ ] Accessibility audit

---

## Phase 3: Expansion

- [ ] Social media platform (spec exists, implementation deferred)
- [ ] Android support
- [ ] Self-hosting capabilities
- [ ] Third-party API ecosystem
- [ ] Supabase migration (from SQLite)
