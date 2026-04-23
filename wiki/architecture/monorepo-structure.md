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
  - "[[social]]"
  - "[[landing]]"
packages:
  - "@osn/api"
  - "@osn/client"
  - "@osn/db"
  - "@osn/ui"
  - "@osn/landing"
  - "@osn/social"
  - "@pulse/app"
  - "@pulse/api"
  - "@pulse/db"
  - "@zap/api"
  - "@zap/db"
  - "@shared/crypto"
  - "@shared/db-utils"
  - "@shared/observability"
  - "@shared/rate-limit"
  - "@shared/redis"
  - "@shared/typescript-config"
last-reviewed: 2026-04-23
---

# Monorepo Structure

The monorepo is organised by **domain**. Four top-level directories, four workspace-name prefixes, one prefix per directory — no mixing.

## Directory-to-Prefix Mapping

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/` | `@osn/*` | Identity stack — auth, social graph, organisations, recommendations, SDK, UI components, landing site, social management app |
| `pulse/` | `@pulse/*` | Events stack — Tauri client, events API (port 3001), DB |
| `zap/` | `@zap/*` | Messaging stack — API (port 3002), DB. App is planned |
| `shared/` | `@shared/*` | Cross-cutting utilities consumable by any stack |

## Full Directory Tree

```
osn/
  api/                 # @osn/api — Bun/Elysia identity server (port 4000): auth, graph, organisations, recommendations
  client/              # @osn/client — SDK: OsnAuthService, useAuth, graph/org/recommendation clients
  db/                  # @osn/db — Drizzle + SQLite (accounts, profiles, passkeys, sessions, graph, orgs, service accounts)
  ui/                  # @osn/ui — shared SolidJS auth components (<SignIn>, <Register>, <RecoveryCodesView>, etc.)
  social/              # @osn/social — SolidJS web app for identity + graph management (port 1422)
  landing/             # @osn/landing — Astro + Solid marketing site
pulse/
  app/                 # @pulse/app — Tauri + SolidJS (iOS target ready)
    src/               #   SolidJS frontend
    src-tauri/         #   Rust + Tauri native layer
  api/                 # @pulse/api — Elysia + Eden events server (port 3001)
  db/                  # @pulse/db — Drizzle + SQLite (events, RSVPs)
zap/
  api/                 # @zap/api — Elysia messaging server (port 3002) — M0 scaffolded; M1+ in flight (see TODO.md)
  db/                  # @zap/db — Drizzle schema (chats, messages, group state)
                       # @zap/app — planned (Tauri + SolidJS messaging client)
shared/
  crypto/              # @shared/crypto — ARC tokens (S2S), recovery codes; Signal Protocol pending
  db-utils/            # @shared/db-utils — createDrizzleClient, makeDbLive
  observability/       # @shared/observability — OTel logger / tracer / metric helpers, Elysia plugin, instrumentedFetch
  rate-limit/          # @shared/rate-limit — per-IP / per-user fixed-window limiter primitives
  redis/               # @shared/redis — Redis client wrapper, rate-limiter Lua, JTI / rotated-session stores
  typescript-config/   # @shared/typescript-config — base.json, node.json, solid.json
```

## Where to find things

| Question | Answer |
|---|---|
| Where does the OSN binary live? | `osn/api` — `@osn/api` is the only OSN runtime. There is no separate `@osn/core` library. |
| Where do auth route factories live? | `osn/api/src/routes/auth.ts` — exported as `createAuthRoutes(config, dbLayer?)`. |
| Where do ARC token primitives live? | `@shared/crypto` (`shared/crypto/src/arc.ts`). |
| Where do shared auth UI components live? | `@osn/ui/auth/*` — consumed by `@osn/social`, Pulse app, future Zap app. |
| Where do Pulse → OSN calls go? | Through `pulse/api/src/services/graphBridge.ts` — see [[s2s-patterns]]. |

## Cross-package Dependencies

The dependency flow is strictly directional:

- `shared/*` packages have no intra-workspace dependencies (they are consumed by everything)
- `osn/*` packages depend on `shared/*` but never on `pulse/*` or `zap/*`
- `pulse/*` packages may depend on `osn/*` (through `graphBridge`) and `shared/*`
- `zap/*` packages may depend on `osn/*` (for identity verification) and `shared/*`
- `pulse/*` and `zap/*` never depend on each other directly

Cross-domain access (e.g. Pulse reading OSN's social graph) goes through a bridge module — see [[s2s-patterns]].

## Tech Stack

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite (migrating to Supabase), Eden+REST, WebSockets, Signal Protocol (planned), SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest.

## Source Files

- [CLAUDE.md](../../CLAUDE.md) — "Current State" section
- [package.json](../../package.json) — root workspace configuration
