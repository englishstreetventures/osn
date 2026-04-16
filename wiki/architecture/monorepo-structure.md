---
title: Monorepo Structure
aliases:
  - workspace layout
  - directory structure
  - domain layout
tags:
  - architecture
  - monorepo
  - workspaces
status: current
related:
  - "[[backend-patterns]]"
  - "[[osn-core]]"
  - "[[pulse]]"
  - "[[zap]]"
  - "[[landing]]"
packages:
  - "@osn/api"
  - "@osn/core"
  - "@osn/client"
  - "@osn/crypto"
  - "@osn/db"
  - "@osn/ui"
  - "@osn/landing"
  - "@pulse/app"
  - "@pulse/api"
  - "@pulse/db"
  - "@zap/app"
  - "@zap/api"
  - "@zap/db"
  - "@shared/db-utils"
  - "@shared/typescript-config"
  - "@shared/observability"
last-reviewed: 2026-04-12
---

# Monorepo Structure

The monorepo is organised by **domain**. Four top-level directories, four workspace-name prefixes, one prefix per directory -- no mixing.

## Directory-to-Prefix Mapping

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/` | `@osn/*` | OSN identity stack (auth, graph, SDK, crypto, landing) |
| `pulse/` | `@pulse/*` | Pulse events stack (app, events API, DB) |
| `zap/` | `@zap/*` | Zap messaging stack (app, messaging API, DB) -- placeholder, see TODO.md |
| `shared/` | `@shared/*` | Cross-cutting utilities consumable by any stack |

## Full Directory Tree

```
osn/
  api/                 # ✓ @osn/api — Bun/Elysia auth server (port 4000); thin wrapper over @osn/core
  landing/             # ✓ @osn/landing — Astro + Solid (marketing site)
  core/                # ✓ @osn/core — auth services + routes (passkey, OTP, magic link, PKCE, JWT, /login/*) + social graph service + routes + hosted /authorize HTML
  client/              # ✓ @osn/client — SDK: createRegistrationClient, createLoginClient, OsnAuthService; @osn/client/solid AuthProvider + useAuth
  crypto/              # ✓ @osn/crypto — ARC tokens (S2S auth); Signal protocol pending
  db/                  # ✓ @osn/db — Drizzle + SQLite (users, passkeys, social graph, service accounts)
  ui/                  # ✓ @osn/ui — shared SolidJS components: <Register>, <SignIn>, <MagicLinkHandler> under @osn/ui/auth/*
pulse/
  app/                 # ✓ @pulse/app — Tauri + SolidJS (iOS target ready). Consumes @osn/client, @osn/ui, @pulse/api
    src/               # SolidJS frontend
    src-tauri/         # Rust + Tauri native layer
  api/                 # ✓ @pulse/api — Elysia + Eden events server (port 3001). Consumed by @pulse/app via @pulse/api/client
  db/                  # ✓ @pulse/db — Drizzle + SQLite (events, RSVPs)
zap/                   # ⏳ placeholder — see zap/README.md and the Zap section of TODO.md
  app/                 # planned: @zap/app — Tauri + SolidJS messaging client
  api/                 # planned: @zap/api — Elysia + Eden messaging server
  db/                  # planned: @zap/db — Drizzle schema (chats, messages, group state)
shared/
  db-utils/            # ✓ @shared/db-utils — createDrizzleClient, makeDbLive (consumed by @osn/db and @pulse/db)
  typescript-config/   # ✓ @shared/typescript-config — base.json, node.json, solid.json
```

Status markers: **✓** = built and functional, **⏳** = placeholder/planned.

## @osn/core vs @pulse/api -- the distinction

This is an important architectural distinction that comes up frequently.

`@osn/core` is a **library** -- it never calls `listen()`. It exports Elysia route factories (`createAuthRoutes`, `createGraphRoutes`) + Effect services. `@osn/api` is the binary that imports it and actually listens on port 4000.

`@pulse/api`, by contrast, **is** the binary -- it runs its own Elysia process on port 3001 and exposes `@pulse/api/client` (an Eden treaty wrapper) for the Pulse frontend to consume. It imports `@pulse/db` and has nothing to do with OSN identity.

Key takeaway: `@osn/core` is consumed as a dependency; `@pulse/api` is a standalone server.

## Sign-in + Register are now shared

Both `<Register />` and `<SignIn />` live in `@osn/ui/auth/*`, receive an injected client prop, and talk to first-party `/login/*` + `/register/*` endpoints that return `{ session, user }` directly (no PKCE). The hosted `/authorize` HTML + PKCE flow stays put in `@osn/core` for third-party OAuth clients but is no longer used by first-party apps like Pulse.

This means any new OSN app (including Zap) can reuse the same auth UI components by importing from `@osn/ui/auth/*` and injecting a client instance from `@osn/client`.

## Cross-package Dependencies

The dependency flow is strictly directional:

- `shared/*` packages have no intra-workspace dependencies (they are consumed by everything)
- `osn/*` packages depend on `shared/*` but never on `pulse/*` or `zap/*`
- `pulse/*` packages may depend on `osn/*` (for identity/graph) and `shared/*`
- `zap/*` packages may depend on `osn/*` (for identity/graph) and `shared/*`
- `pulse/*` and `zap/*` never depend on each other directly

Cross-domain access (e.g. Pulse reading OSN's social graph) goes through a bridge module -- see [[s2s-patterns]] for details.

## Tech Stack

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite (migrating to Supabase), Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest.

## Source Files

- [CLAUDE.md](../CLAUDE.md) -- "Current State" section
- [package.json](../package.json) -- root workspace configuration
