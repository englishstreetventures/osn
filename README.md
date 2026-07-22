# Open Social Network (OSN)

An open, modular social platform. You own your identity and social graph, and choose which apps see them.

## Vision

OSN splits the social graph from the apps that use it. You own your identity and relationships, opt into apps one at a time, and your access rules follow you across all of them. Block someone on OSN and the block reaches every app you connect — unless you say otherwise.

## Core Principles

- **Modular**: each capability (events, messaging, weddings, social media) is a standalone app. Use what you want, ignore the rest.
- **Transparent data**: read every piece of personalisation data we hold on you, and wipe it any time.
- **Private by design**: E2E encryption for messaging (Signal Protocol), fine-grained visibility rules, hidden-attendance options.
- **Open standards**: OSN is an OIDC issuer, so third parties can build on it. Self-hosting is planned for enterprise use.

## Status

Phase 1. Three surfaces run in production on Cloudflare; the rest run locally.

| Surface | Packages | Where it runs |
|---|---|---|
| Identity / auth API | `@osn/api` | Live — Worker on `id.cireweddings.com` |
| Wedding invites (Cire) | `@cire/api`, `@cire/web`, `@cire/organiser`, `@cire/vendor`, `@cire/db`, `@cire/theme` | Live — `cireweddings.com` zone |
| Wedding marketing site | `@cire/landing` | Live — apex `cireweddings.com` |
| Identity & graph UI | `@osn/social` | Local only |
| Events (Pulse) | `@pulse/app`, `@pulse/api`, `@pulse/db` | Local only |
| Messaging (Zap) | `@zap/api`, `@zap/db` | Worker on `zap.cireweddings.com` — M1 in flight, client app not started |
| OSN / Pulse marketing sites | `@osn/landing`, `@pulse/landing` | Built, not yet deployed |

CI deploys the `osn-api`, `cire-api` and `zap-api` Workers, the guest site (Worker SSR) and the organiser, vendor and landing sites (Pages) on merge to `main`. D1 migrations apply automatically. See `wiki/runbooks/production-deploy.md`.

## Applications

### OSN Core

The identity and social-graph layer, and the OIDC issuer other apps authenticate against.

- Passkeys are the only primary login (WebAuthn / FIDO2). OTP survives as a step-up factor; magic links and PKCE primary flows are gone
- Server-side session store with rotation and reuse detection (Copenhagen Book C1/C2/C3)
- Short-lived ES256 access tokens (5-minute TTL, `aud: "osn-access"`), public keys at `/.well-known/jwks.json`. Downstream services verify through `@shared/osn-auth-client`
- Per-device session list, "sign out everywhere else", per-passkey rename and delete
- Recovery codes for a lost device (Copenhagen Book M2)
- Step-up "sudo" tokens for sensitive actions — recovery-code generation, email change, passkey delete
- Cross-device login by QR code
- Social graph: connections, close friends, blocked users
- Many profiles per account (one login, several public handles)
- Friends-of-friends recommendations
- Organisations, with ARC service-to-service tokens for internal calls

### Cire (Wedding invites)

A bespoke digital wedding invite: a tactile, animated guest site plus a portal where the couple runs the guest list. Once its own repo, now a sibling workspace. The schema is already multi-tenant (a `weddings` root table), so it can become a product without a rewrite.

- Guest site — claim code unlocks the invite, then events, details and RSVP
- Organiser portal — guest and event tables, spreadsheet import, per-section invite theming, co-hosts added by OSN handle
- Vendor portal — vendor profiles and couple enquiries
- Two auth models that never overlap. Guests trade a family claim code for a hashed session cookie, and never need an OSN account. Organisers sign in with their OSN passkey, checked against wedding ownership
- Optional account linking lets a guest attach their seat to an OSN account

Detail lives in `wiki/apps/cire.md` and `wiki/systems/cire-auth.md`.

### Pulse (Events)

A unified events platform: the social ease of Facebook Events, the fun of Partiful and Luma, the tooling of Eventbrite.

- Discovery by location, category, date, friends attending, interests
- Default view: what's happening today near you
- Event lifecycle: Not Started → Started (configurable ticket cutoff) → Ongoing → Finished
- Recurring events as a parent series with child instances
- Organiser tools: moderation, cross-event blacklists, ticket setup
- Venue pages — a nightclub with its DJ schedule, genres and nightly events
- Event group chats, served by the messaging backend
- Calendar view with iCal export (one-way sync to Google and Apple Calendar)
- Hidden attendance for private events
- Share-source attribution — which channel brought each RSVP in

### Zap (Messaging)

Secure, playful messaging that doubles as the ecosystem's support and announcements channel. Aim: between Messenger, Instagram and iMessage — playful but not loud, modern, secure, open.

**Two top-level views:**

1. **Socials** — DMs, group chats, organisation chats; filterable.
2. **AI** — conversations with AI models, kept out of the normal inbox.

**Core features:**

- DMs and group chats
- Disappearing messages, per chat
- Themes, stickers, GIFs, polls, easter-egg mini-games
- E2E encryption via Signal Protocol (`@shared/crypto`, planned)
- Event group chats reachable from both Pulse and Zap, with the event overview in chat settings
- Backups: encrypted cloud, self-hosted cloud, or local only
- Device transfer

**Key differentiator — organisation chats:**

- **Verified organisations** — blue-tick verification for businesses, public bodies and NGOs.
- **Support over a Zap handle** — a business replaces `support@acme.com` with `@acme`. Phishing gets harder because the verified handle is the only source of truth.
- **Embeddable web widget** — a third-party site swaps its email-capture support form for "Enter your OSN handle". The thread lands in Zap under the verified organisation with full history. Checkouts can capture a handle next to (or instead of) an email to smooth post-purchase support.
- **Organisation tooling** — dashboards for triage, agent assignment, analytics, SLA monitoring and audit.
- **Locality and government channels** — users opt into a locality (home city, plus a temporary one while travelling) and get official notices — floods, evacuations, public safety. AI-assisted queries route people to authoritative answers ("where is the nearest relief centre?") in real time.

`@zap/api` and `@zap/db` are scaffolded (M0 done, M1 in flight). `@zap/app`, the Tauri + SolidJS client, has not started. See `wiki/TODO.md` and `wiki/apps/zap.md`.

### Social media (spec only, deferred)

Multi-format social content: text posts, image posts, long-form writing, short-form video. Switch off any format you don't want — short video, say — and it disappears.

## Architecture

### Monorepo structure

Organised by domain. Five top-level directories, one workspace prefix each.

```
osn/              # @osn/* — identity stack
  api/              # Elysia identity server (:4000; prod Worker id.cireweddings.com)
  client/           # Client SDK (Effect-based + SolidJS bindings)
  db/               # Drizzle schema — accounts, profiles, passkeys, sessions, graph, orgs
  ui/               # Shared SolidJS auth components (<SignIn>, <Register>, <SessionsView>…)
  social/           # SolidJS app for identity + graph management (:1422)
  landing/          # Marketing site, Astro + Solid (:4324)

pulse/            # @pulse/* — events stack
  app/              # Tauri + SolidJS client
  api/              # Elysia + Eden events server (:3001)
  db/               # Drizzle schema — events, RSVPs
  landing/          # Marketing site (:4325)

zap/              # @zap/* — messaging stack (M0 scaffolded; client planned)
  api/              # Elysia messaging server (:3002)
  db/               # Drizzle schema — chats, messages, group state

cire/             # @cire/* — wedding-invite stack
  api/              # Elysia on Cloudflare Workers (:8787; prod api.cireweddings.com)
  web/              # Guest invite site, Astro + SolidJS (:4321; prod invite.cireweddings.com)
  organiser/        # Organiser portal (:4322; prod host.cireweddings.com)
  vendor/           # Vendor portal (:4326)
  landing/          # Marketing site for the apex (:4323)
  db/               # Drizzle schema + D1 migrations
  theme/            # Zero-dependency theming validators (CSS-colour allowlist)

shared/           # @shared/* — cross-cutting utilities
  crypto/            # ARC tokens, recovery-code helpers (Signal Protocol planned)
  db-utils/          # Driver-agnostic Drizzle handle, makeDbLive, makeD1DbLive
  email/             # EmailService Tag — Resend / Cloudflare / Log / Noop transports
  feature-flags/     # Key-optional, fail-safe flag client (GrowthBook)
  observability/     # OpenTelemetry helpers, Elysia plugin, instrumentedFetch
  osn-auth-client/   # Downstream access-JWT verification — JWKS cache, Elysia adapter
  rate-limit/        # Per-IP / per-user limiter primitives, client-IP trust policy
  redis/             # Redis wrapper, rate-limiter Lua, JTI / rotated-session stores
  turnstile/         # Key-optional, fail-closed Turnstile verifier
  typescript-config/ # base / node / solid tsconfigs
```

Each Tauri app keeps the standard layout: `src/` SolidJS frontend, `src-tauri/` Rust layer with iOS and Android targets.

**Prefix rule:** every workspace sits under exactly one of `osn/`, `pulse/`, `zap/`, `cire/` or `shared/`, and its `package.json` `name` uses the matching prefix.

Dependencies flow one way: `shared/*` depends on nothing internal; `osn/*` depends on `shared/*`; `pulse/*`, `zap/*` and `cire/*` may depend on `osn/*` and `shared/*` but never on each other. Cross-domain reads go through a bridge module — Pulse reaches the social graph through `graphBridge`, Cire through ARC-gated internal endpoints.

### Backend

- **Elysia** on Bun locally, on Cloudflare Workers in production. Workers builds run with `aot: false` — Elysia's ahead-of-time compilation uses `new Function`, which workerd forbids
- **Effect.ts** for services. The layer graph is built once at boot as a shared `ManagedRuntime`, never per request
- **Eden treaty** for type-safe internal calls; plain REST for third-party consumers
- **ARC tokens** — self-issued ES256 JWTs with `kid`, scope and audience — for service-to-service auth
- **WebSockets** for live messaging and event updates (planned)
- **Rate limiting** on auth, graph and org writes. Fail-closed. Native Workers rate-limit bindings for the 60-second windows, Upstash Redis for the rest
- **Turnstile** bot protection on register, login, claim and RSVP. Key-optional: no secret means the check is inert

### Databases

Four environments, two drivers, one Drizzle type:

| Environment | Driver | Where |
|---|---|---|
| `local` | bun:sqlite | Dev machine — `bun run dev` and in-memory tests |
| `dev` | Cloudflare D1 | `wrangler dev --env dev` (miniflare) or deployed |
| `staging` | Cloudflare D1 | Deployed |
| `production` | Cloudflare D1 | Deployed |

`@shared/db-utils` broadens the Drizzle handle over both the sync (bun:sqlite) and async (D1) result kinds, so the same query code runs everywhere — service code must `await`. See `wiki/systems/database-environments.md`.

### Frontend

- **Standalone apps first**, working toward a hybrid super-app
- **iOS first**, then web, then Android (Android deferred)
- **SolidJS** everywhere; **Astro + Solid** for the web surfaces and marketing sites
- **Tauri** for native builds
- Shared components in `@osn/ui`, built on Kobalte in the Zaidan (shadcn-for-Solid) style

### Messaging architecture

`@zap/api` is the shared messaging backend, in two modes:

- **Direct** — the user has opted into Zap
- **Indirect** — the user only touches messaging through another app, e.g. a Pulse event chat

So Pulse users can join event chats without installing Zap.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun (local), Cloudflare Workers (production) |
| Language | TypeScript |
| Backend framework | Elysia |
| Functional core | Effect.ts |
| ORM | Drizzle |
| Database | bun:sqlite (local) → Cloudflare D1 (dev/staging/prod) |
| Cache / limiters | Upstash Redis, native Workers rate-limit bindings |
| API communication | Eden (internal), REST (external) |
| Real-time | WebSockets |
| Encryption | Signal Protocol (planned), ES256 JWTs, WebAuthn |
| Email | Resend HTTP API |
| Frontend framework | SolidJS |
| Web / marketing sites | Astro + Solid, on Cloudflare Pages |
| Native apps | Tauri |
| Monorepo | Turborepo |
| Testing | Vitest + @effect/vitest |
| Linting | oxlint |
| Formatting | oxfmt |
| Validation | Elysia TypeBox at the HTTP boundary, Effect Schema in services |
| Observability | OpenTelemetry → Grafana Cloud |
| Feature flags | GrowthBook |
| Versioning | Changesets |

## Getting Started

You need [Bun](https://bun.sh) — the pinned version is in `.bun-version`.

```bash
bun install              # install every workspace
bun run dev              # start everything (turbo)
```

Most of the time you want one stack, not all of them:

```bash
bun run dev:osn          # identity API
bun run dev:social       # identity API + social app
bun run dev:pulse        # pulse API + app, identity API, zap API
bun run dev:zap          # zap API + identity API
bun run dev:cire         # cire API + guest + organiser, identity API
bun run dev:apis         # backends only
```

Packages that need configuration ship a `.env.example` — copy it to `.env` and fill it in. Missing secrets degrade rather than break: no Resend key logs emails instead of sending them, no Turnstile secret leaves the bot check inert.

Checks:

```bash
bun run check            # type-check
bun run test             # all tests
bun run lint             # oxlint
bun run fmt              # oxfmt
```

Database work runs from the owning package:

```bash
bun run --cwd cire/db db:migrate    # generate migrations
bun run --cwd pulse/db db:studio    # Drizzle Studio
bun run db:reset                    # reset every local database
```

`CLAUDE.md` holds the full command list and the code conventions.

## Data Models (conceptual)

### Account and profile

- Identity (OIDC subject), passkeys, sessions, recovery codes
- One account, many profiles — each with its own public handle
- Interests and personalisation data, readable and resettable by the user

### Social graph

- Connections (mutual follow / friend)
- Close friends
- Blocks, OSN-wide or per app
- App authorisations

### Event

- Basics: title, description, location, date and time
- Lifecycle state, moved automatically by the clock
- Configuration: late joins, ticket limits
- Parent series reference, for recurring events
- Associated chat
- Organiser, attendees, category, tags

### Event series

- Recurrence pattern
- Child event instances

### Message / chat

- E2E encrypted content
- Type: DM, group, or event-linked
- Participants, and an event reference for event chats

### Wedding

- Wedding root, owner profile, co-hosts
- Families with claim codes, and the guests inside them
- Events, sections and per-section theming
- RSVPs, dietary notes, vendor enquiries

## Moderation

- **User reporting** across every app
- **Community notes** — collaborative context, Twitter-style
- **Organiser controls** for event spaces
- **Organisation blacklists** spanning many events

## Contributing

Every change goes through a pull request. Nobody pushes to `main`.

Work on a feature branch, and include a changeset describing the change and the packages it touches:

```bash
bun run changeset
```

Pick the packages, pick the bump type, write a summary. The CI "Changeset Check" job fails without one. It enforces two rules. Package names must match the workspace `name` exactly — `"@pulse/app"`, not `"pulse"`. One changeset must not mix version-less packages (`@cire/*`) with versioned ones.

On merge, CI runs `changeset version` to bump versions and update changelogs, commits that to `main`, and deploys the live surfaces.

Read next:

- [`CLAUDE.md`](CLAUDE.md) — conventions, commands, key patterns, wiki navigation
- [`wiki/index.md`](wiki/index.md) — map of the knowledge base
- [`wiki/TODO.md`](wiki/TODO.md) — progress, backlogs, deferred decisions

## License

GNU General Public License v3.0 (GPLv3)
