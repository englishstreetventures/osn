# Open Social Network (OSN)

An open-source, transparent, and modular social platform that gives users complete control over their social graph and data.

## Vision

OSN decouples the social graph from applications. Users own their identity and relationships, choosing which apps to opt into while maintaining consistent access controls across all connected services. Block someone on OSN, and that block propagates to any app you've connected - unless you choose otherwise.

## Core Principles

- **Modularity**: Each capability (events, messaging, social media) is a standalone app. Use what you want, ignore what you don't.
- **Data Transparency**: All personalization data is accessible to users and can be reset at any time.
- **Privacy by Design**: E2E encryption for messaging (Signal protocol), granular visibility controls, hidden attendance options.
- **Open Standards**: OAuth/OIDC provider for third-party integrations. Self-hosting capabilities planned for enterprise use.

## Applications

### OSN Core
The identity and social graph layer. Acts as the OIDC issuer that other apps authenticate against.

**Key Features:**
- Passkey-only primary login (WebAuthn / FIDO2). OTP survives only as a step-up factor; magic-link / PKCE primary surfaces removed
- Server-side session store with rotation + reuse detection (Copenhagen Book C1/C2/C3)
- Per-device session list, "sign out everywhere else", per-passkey rename / delete
- Recovery codes for lost-device escape (Copenhagen Book M2)
- Step-up "sudo" tokens for sensitive actions (recovery code generation, email change)
- Social graph (connections, close friends, blocked users)
- Multi-profile per account (one login → multiple public handles)
- Friends-of-friends recommendations

### Pulse (Events)
A unified events platform combining the social ease of Facebook Events, the fun of Partiful/Luma, and the comprehensive tooling of Eventbrite.

**Key Features:**
- Event discovery by location, category, datetime, friends attending, interests
- Default view: "What's happening today in your area"
- Event lifecycle states: Not Started → Started (configurable ticket cutoff) → Ongoing → Finished
- Recurring events as parent series with child instances
- Organizer tools: moderation, cross-event blacklists, ticket configuration
- Venue pages (e.g., nightclubs with DJ schedules, genres, nightly events)
- Event group chats (powered by messaging backend)
- Calendar view with iCal export (one-way sync to Google Calendar, Apple Calendar)
- Hidden attendance option for private events

### Zap (Messaging)
Secure, playful messaging that doubles as the OSN ecosystem's
identity-aware customer-support and announcements channel. Visually:
somewhere between Messenger, Instagram, and iMessage — playful but not
overbearing, modern, secure, transparent.

**Two top-level views:**
1. **Socials** — DMs, group chats, organisation chats; filterable.
2. **AI** — dedicated view for conversations with AI models, kept out
   of the regular inbox.

**Core features:**
- DMs and group chats
- Disappearing messages (optional, per chat)
- Themes
- Easter-egg mini-games
- Stickers and GIFs
- Polls
- AI model conversations (dedicated view)
- E2E encryption via Signal Protocol (`@shared/crypto`, planned)
- Event group chats accessible from both Pulse and Zap
- Event overview visible in group chat settings
- Backup options: encrypted cloud, self-hosted cloud, local-only
- Device transfer support

**Key differentiator — Organisation chats:**
- **Verified organisations** — blue-tick-style verification for
  businesses, public bodies, and NGOs.
- **Customer support via Zap handle** — businesses replace
  `support@acme.com` with `@acme`. Phishing surface drops because the
  verified handle is the source of truth.
- **Embeddable web widget** — third-party sites swap their
  email-capture support form for "Enter your OSN handle". The
  conversation surfaces in Zap under the verified organisation account
  with full history. E-commerce checkouts can capture an OSN handle
  alongside (or instead of) email to streamline post-purchase support.
- **Organisation tooling** — backend dashboards for triage, agent
  assignment, analytics, SLA monitoring, and audit.
- **Locality / government channels** — users opt in to a locality
  (their home city, plus temporary subscriptions while travelling) and
  receive official announcements (floods, evacuation, public safety)
  directly. AI-assisted queries route citizens to authoritative answers
  ("where's the nearest relief centre?") in real time.

Implementation lives under `zap/`. `@zap/api` and `@zap/db` are
scaffolded (M0 done; M1 in flight); `@zap/app` (Tauri + SolidJS client)
has not been started yet. See [`wiki/TODO.md`](wiki/TODO.md) and
[`wiki/apps/zap.md`](wiki/apps/zap.md) for the milestone roadmap.

### Social Media Platform (Spec Only - Deferred)
Multi-format social content with opt-out granularity.

**Planned Formats:**
- Text-based (Twitter-like)
- Posts (Instagram-like)
- Long-form content
- Short-form video

Users can opt out of specific formats (e.g., disable short-form video entirely).

## Architecture

### Monorepo Structure

The monorepo is organised by domain. Four top-level directories, one
workspace prefix each:

```
osn/              # @osn/* — identity stack
  api/              # Bun/Elysia identity server (port 4000) — auth, graph, orgs, recommendations
  client/           # Client SDK (Effect-based + SolidJS bindings)
  db/               # Drizzle schema — accounts, profiles, passkeys, sessions, graph, service accounts
  ui/               # Shared SolidJS auth components (<SignIn>, <Register>, <SessionsView>, etc.)
  social/           # SolidJS web app for identity + social-graph management (port 1422)
  landing/          # Marketing site (Astro + Solid)

pulse/            # @pulse/* — events stack
  app/              # Tauri + SolidJS frontend
  api/              # Elysia + Eden events server (port 3001)
  db/               # Drizzle schema — events, RSVPs

zap/              # @zap/* — messaging stack (M0 scaffolded; client app planned)
  api/              # Elysia messaging server (port 3002)
  db/               # Drizzle schema — chats, messages, group state

shared/           # @shared/* — cross-cutting utilities
  crypto/            # ARC tokens, recovery-code helpers (Signal Protocol planned)
  db-utils/          # createDrizzleClient, makeDbLive
  observability/     # OpenTelemetry helpers, Elysia plugin, instrumentedFetch
  rate-limit/        # in-memory + interface for per-IP / per-user limiters
  redis/             # Redis client wrapper, rate-limiter Lua, JTI / rotated-session stores
  typescript-config/ # base / node / solid tsconfigs
```

Each Tauri app follows the standard structure:
- `src/` — SolidJS frontend
- `src-tauri/` — Rust native layer with iOS/Android targets

**Prefix rule:** every workspace lives under exactly one of `osn/`,
`pulse/`, `zap/`, or `shared/`, and its `package.json` `name` field uses
the matching prefix.

### Backend
- **Single unified API** serving all apps with domain modules
- **Elysia** web framework with Eden treaty for type-safe internal communication
- **REST endpoints** exposed for third-party OAuth/API consumers
- **Effect.ts** for composable, functional patterns (trial with OSN/Pulse first)
- **WebSockets** for real-time messaging and live event updates
- **SQLite** for local development (Supabase migration planned)

### Frontend
- **Standalone apps first**, working toward a hybrid super-app
- **iOS priority**, then Web, then Android (Android deferred)
- **Shared UI components** via `@osn/ui` (`osn/ui/`)
- **SolidJS** for reactive UI rendering
- **Tauri** for native iOS builds (follows Tauri's project conventions)
- **Astro + Solid** for landing/marketing site

### Messaging Architecture
`@zap/api` serves as the shared messaging backend:
- **Direct mode**: User has opted into the Zap app
- **Indirect mode**: User only uses messaging features through other apps (e.g., Pulse event chats)

This allows Pulse users to participate in event chats without requiring a full Zap install.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Language | TypeScript |
| Backend Framework | Elysia |
| Functional Patterns | Effect.ts (trial) |
| ORM | Drizzle |
| Database | SQLite (local) → Supabase (production) |
| API Communication | Eden (internal), REST (external) |
| Real-time | WebSockets |
| Encryption | Signal Protocol |
| Frontend Framework | SolidJS |
| Landing Site | Astro + Solid |
| Native Apps | Tauri |
| Monorepo | Turborepo |
| Linting | oxlint |
| Formatting | oxfmt |
| Validation | Elysia TypeBox at HTTP boundary, Effect Schema in services |

## Data Models (Conceptual)

### User
- Identity (OAuth/OIDC subject)
- Profile information
- Interest selections
- Personalization data (user-accessible, resettable)

### Social Graph
- Connections (mutual follow/friend)
- Close Friends designation
- Blocks (OSN-wide or per-app)
- App authorizations

### Event
- Basic info (title, description, location, datetime)
- Lifecycle state (auto-transitioning based on time)
- Configuration (allow late joins, ticket limits)
- Parent series reference (for recurring events)
- Associated chat (messaging backend)
- Organizer + attendees
- Category + tags

### Event Series
- Recurrence pattern
- Child event instances

### Message / Chat
- E2E encrypted content
- Chat type (DM, group, event-linked)
- Participants
- Event reference (if event chat)

## Moderation

- **User reporting** across all apps
- **Community notes** (Twitter-style collaborative context)
- **Organizer controls** for event spaces
- **Organization blacklists** spanning multiple events

## Contributing

All changes go through pull requests — direct pushes to `main` are not permitted.

**Every PR must include a changeset** describing the change type and affected packages. To create one:

```bash
bun run changeset
```

Select the packages affected, choose the bump type (patch/minor/major), and write a summary. The CI "Changeset Check" job will fail without one.

On merge, CI automatically runs `changeset version` to bump package versions and update changelogs, then commits the result directly to `main`.

See also:
- [`wiki/TODO.md`](wiki/TODO.md) — current progress, task checklists, deferred decisions
- [`CLAUDE.md`](CLAUDE.md) — AI assistant reference, code patterns, commands
- [`wiki/index.md`](wiki/index.md) — full Map of Content for the knowledge base

## License

GNU General Public License v3.0 (GPLv3)
