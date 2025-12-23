# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Monorepo scaffolding complete. Ready to initialize Tauri apps and begin core development.

---

## Deferred Decisions

Decisions to revisit later. Add new items as they come up.

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Messaging app name | Need a catchy name | Before public launch |
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| Effect.ts adoption | Trial with OSN/Pulse backend first | After trial evaluation |
| Supabase migration | Currently SQLite for simplicity | When scaling needed |
| Android support | iOS priority for now | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |

---

## Phase 1: Foundation

### Infrastructure
- [x] Turborepo setup
- [x] Changesets for versioning
- [x] Shared TypeScript configs
- [x] Package structure (api, db, ui, core, crypto)
- [x] CI/CD pipeline (GitHub Actions)
- [x] Linting/formatting in CI
- [x] Claude Code GitHub integration (@claude mentions, PR reviews)
- [x] Automated security review on PRs

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
- [ ] Initialize Tauri app (`bunx tauri init`)
- [ ] Event data model and schema
- [ ] Event CRUD operations
- [ ] Event lifecycle auto-transitions
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
- [ ] Effect.ts trial integration
- [ ] Domain modules (osn, pulse, messaging)
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`packages/db`)
- [x] Drizzle + SQLite setup
- [ ] User schema
- [ ] Social graph schema
- [ ] Event schema
- [ ] Event series schema
- [ ] Chat/Message schema
- [ ] Migrations

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
