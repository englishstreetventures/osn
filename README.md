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
The identity and social graph layer. Acts as an OAuth/OIDC provider that other apps authenticate against.

**Key Features:**
- User identity management
- Social graph (connections, close friends, blocked users)
- Granular blocking (OSN-wide or per-app)
- Third-party app authorization
- Interest profiles (explicit selection + behavioral refinement)

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

### Messaging App (Name TBD)
Secure messaging with deep integration into the OSN ecosystem.

**Key Features:**
- Signal protocol for E2E encryption
- Event group chats accessible from both Pulse and Messaging
- Event overview visible in group chat settings
- Backup options: encrypted cloud, self-hosted cloud, local-only
- Device transfer support

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

The monorepo is organised by domain. Three top-level directories, one
workspace prefix each:

```
osn/              # @osn/* — identity stack
  app/              # Bun/Elysia auth server (port 4000)
  core/             # Auth + social graph library (services, routes, hosted HTML)
  client/           # Client SDK (Effect-based + SolidJS bindings)
  crypto/           # ARC S2S tokens (Signal Protocol to come)
  db/               # Drizzle schema — users, passkeys, graph, service accounts
  ui/               # Shared SolidJS auth components (<SignIn>, <Register>)
  landing/          # Marketing site (Astro + Solid)

pulse/            # @pulse/* — events stack
  app/              # Tauri + SolidJS frontend
  api/              # Elysia + Eden events server (port 3001)
  db/               # Drizzle schema — events, RSVPs

shared/           # @shared/* — cross-cutting utilities
  db-utils/         # createDrizzleClient, makeDbLive
  typescript-config/ # base / node / solid tsconfigs
```

Each Tauri app follows the standard structure:
- `src/` - SolidJS frontend
- `src-tauri/` - Rust native layer with iOS/Android targets

**Prefix rule:** every workspace lives under exactly one of `osn/`,
`pulse/`, or `shared/`, and its `package.json` `name` field uses the
matching prefix. There are no cross-domain prefixes — `@osn/api` etc. are
gone for good.

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
The messaging backend serves as a shared service:
- **Direct mode**: User has opted into the Messaging app
- **Indirect mode**: User only uses messaging features through other apps (e.g., Pulse event chats)

This allows Pulse users to participate in event chats without requiring full Messaging app opt-in.

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
| Validation | Elysia built-in + Valibot |

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
- `TODO.md` - Current progress, task checklists, deferred decisions
- `CLAUDE.md` - AI assistant reference, code patterns, commands

## License

GNU General Public License v3.0 (GPLv3)
