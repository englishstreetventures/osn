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
  - "[[osn-and-musubi]]"
  - "[[component-library]]"
  - "[[osn-core]]"
  - "[[pulse]]"
  - "[[zap]]"
  - "[[social]]"
  - "[[osn-landing]]"
  - "[[cire]]"
packages:
  - "@osn/api"
  - "@osn/auth-ui"
  - "@osn/client"
  - "@osn/db"
  - "@shared/ui"
  - "@musubi/landing"
  - "@musubi/social"
  - "@pulse/web"
  - "@pulse/api"
  - "@pulse/db"
  - "@pulse/landing"
  - "@zap/api"
  - "@zap/db"
  - "@cire/api"
  - "@cire/db"
  - "@cire/landing"
  - "@cire/host"
  - "@cire/theme"
  - "@cire/vendor"
  - "@cire/invites"
  - "@cire/invite-designs"
  - "@cire/ui"
  - "@shared/color"
  - "@shared/crypto"
  - "@shared/db-utils"
  - "@shared/design-tokens"
  - "@shared/dev-urls"
  - "@shared/email"
  - "@shared/feature-flags"
  - "@shared/legal"
  - "@shared/observability"
  - "@shared/openapi-tools"
  - "@shared/osn-auth-client"
  - "@shared/rate-limit"
  - "@shared/realtime"
  - "@shared/redis"
  - "@shared/rp-auth"
  - "@shared/sortable"
  - "@shared/toast"
  - "@shared/turnstile"
  - "@shared/typescript-config"
  - "@tools/lab"
  - "@tools/metrics"
  - "@tools/oxlint-house"
  - "@tools/pr-metrics"
last-reviewed: 2026-09-27
---

# Monorepo Structure

The monorepo is organised by **domain**. Six top-level directories, six workspace-name prefixes, one prefix per directory — no mixing. A seventh, `tools/`, holds the local-only developer tooling under `@tools/*`.

## Directory-to-Prefix Mapping

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/` | `@osn/*` | OSN the system — auth, social graph, organisations, recommendations, SDK, DB, and the auth views paired with its named ceremonies |
| `musubi/` | `@musubi/*` | Musubi, our implementation — the identity/social app and its marketing site |
| `pulse/` | `@pulse/*` | Events stack — client, events API (port 3001), DB |
| `zap/` | `@zap/*` | Messaging stack — API (port 3002), DB. App is planned |
| `cire/` | `@cire/*` | Wedding-invite stack — guest site, organiser portal, vendor portal, API, DB, theme validators, house components, marketing site |
| `shared/` | `@shared/*` | Cross-cutting utilities and the UI primitives, consumable by any stack |
| `tools/` | `@tools/*` | Local-only developer tooling — never shipped to a user |

## Full Directory Tree

```
osn/                   # OSN the system — headless, plus the views of its own ceremonies
  api/                 # @osn/api — Bun/Elysia identity server (port 4000): auth, graph, organisations, recommendations
  auth-ui/             # @osn/auth-ui — SolidJS views for OSN's ceremonies (<SignIn>, <Register>, <StepUpDialog>, <TotpView>, …), built on @shared/ui
  client/              # @osn/client — SDK: OsnAuthService, useAuth, graph/org/recommendation clients
  db/                  # @osn/db — Drizzle + SQLite (accounts, profiles, passkeys, sessions, graph, orgs, service accounts)
  ios/                 # Musubi iOS app target — thin; the code is in shared/swift/OSNShared
musubi/                # Musubi — our implementation of OSN
  social/              # @musubi/social — SolidJS web app for identity + graph management (port 1422; prod musubi.social)
  landing/             # @musubi/landing — Astro + Solid marketing site (port 4324)
pulse/
  web/                 # @pulse/web — SolidStart app, client-rendered
    src/               #   SolidJS frontend
  api/                 # @pulse/api — Elysia + Eden events server (port 3001)
  db/                  # @pulse/db — Drizzle + SQLite (events, RSVPs)
  landing/             # @pulse/landing — Astro + Solid marketing site (port 4325)
  ios/                 # Pulse iOS app target
zap/
  api/                 # @zap/api — Elysia messaging server (port 3002) — M0 scaffolded; M1+ in flight (see the `product:zap` issues)
  db/                  # @zap/db — Drizzle schema (chats, messages, group state)
                       # @zap/app — planned (SolidJS messaging client)
cire/
  invites/             # @cire/invites — Astro + SolidJS guest invite site (port 4321; prod invite.cireweddings.com)
  host/                # @cire/host — Astro + SolidJS organiser portal (port 4322; prod host.cireweddings.com)
  vendor/              # @cire/vendor — Astro + SolidJS vendor portal (port 4326; prod vendor.cireweddings.com)
  api/                 # @cire/api — Elysia on Cloudflare Workers (port 8787; prod api.cireweddings.com)
  db/                  # @cire/db — Drizzle schema + D1 migrations
  theme/               # @cire/theme — zero-dep shared theming validators (CSS-colour allow-list)
  ui/                  # @cire/ui — cire's house component layer on top of @shared/ui. Version-less like every @cire/* package
  invite-designs/      # @cire/invite-designs — the invite design catalog: ids, names, entitlement tiers
  landing/             # @cire/landing — Astro + Solid marketing site for the apex (port 4323; prod cireweddings.com)
shared/
  color/               # @shared/color — OKLCH parsing / conversion / contrast maths, lifted out of @cire/theme so no @shared/* depends on a @cire/* one
  crypto/              # @shared/crypto — ARC tokens (S2S), recovery codes, RFC 6238 TOTP; Signal Protocol pending
  db-utils/            # @shared/db-utils — createDrizzleClient, makeDbLive, commitBatch, rowsChanged, the search helpers
  design-tokens/       # @shared/design-tokens — the ui-* contract every shared component reads, its scales, and the WCAG conformance harness
  dev-urls/            # @shared/dev-urls — the dev-env launcher: derives every sibling app's origin from this app's own PORTLESS_URL
  email/               # @shared/email — EmailService Tag: Resend / Cloudflare / Log / Noop transports
  feature-flags/       # @shared/feature-flags — key-optional, fail-safe GrowthBook flag client
  legal/               # @shared/legal — the operator identity every published legal page must state
  observability/       # @shared/observability — OTel logger / tracer / metric helpers, Elysia plugin, instrumentedFetch
  openapi-tools/       # @shared/openapi-tools — OpenAPI spec generation and normalisation (specs land in shared/openapi/)
  osn-auth-client/     # @shared/osn-auth-client — downstream access-JWT verification (JWKS cache, Elysia adapter)
  rate-limit/          # @shared/rate-limit — per-IP / per-user fixed-window limiter primitives, getClientIp trust policy
  realtime/            # @shared/realtime — invalidation signals over WebSocket: the per-topic Durable Object hub, publish/subscribe helpers, the browser client and useTopic
  redis/               # @shared/redis — Redis client wrapper, rate-limiter Lua, JTI / rotated-session stores
  rp-auth/             # @shared/rp-auth — browser half of an OSN relying party: the redirect sign-in flow and its cookie contract
  sortable/            # @shared/sortable — drag-to-reorder for SolidJS: pointer sensor, closestCenter, multi-container, and the whole keyboard / screen-reader path
  toast/               # @shared/toast — SolidJS toasts themed through --toast-* custom properties
  turnstile/           # @shared/turnstile — key-optional, fail-closed Turnstile verifier
  typescript-config/   # @shared/typescript-config — base.json, node.json, solid.json
  ui/                  # @shared/ui — the SolidJS primitives (Button, Card, Modal, Field, Table, Input, Select, …) plus cn() and clsx()
  openapi/             # generated OpenAPI documents — not a workspace
  swift/               # OSNShared — the local SPM package the iOS targets depend on; not a workspace
  test-config/         # shared Vitest guard config — not a workspace
tools/                 # local-only developer tooling, never shipped
  lab/                 # @tools/lab — component / three.js scratchpad (`bun run dev:lab`)
  metrics/             # @tools/metrics — session-metrics dashboard over .claude/metrics
  pr-metrics/          # @tools/pr-metrics — the session-performance cards themselves
  oxlint/house/        # @tools/oxlint-house — this repo's own lint rules (oxlint/anti-slop beside it is a vendored upstream copy)
```

## Where to find things

| Question | Answer |
|---|---|
| Where does the OSN binary live? | `osn/api` — `@osn/api` is the only OSN runtime. There is no separate `@osn/core` library. |
| Where do auth route factories live? | `osn/api/src/routes/auth/` — `createAuthRoutes(config, dbLayer?)` composes per-domain route groups from `index.ts`. |
| Where do ARC token primitives live? | `@shared/crypto` (`shared/crypto/src/arc.ts`). |
| Where do shared auth UI components live? | `@osn/auth-ui/*` — the views for OSN's named ceremonies. Consumed by `@musubi/social` today. |
| Where do the UI primitives live? | `@shared/ui` — `@shared/ui/ui/<name>` for components, `@shared/ui/lib/utils` for `cn()` / `clsx()`. See [[component-library]]. |
| Where do Pulse → OSN calls go? | Through `pulse/api/src/services/graphBridge.ts` — see [[s2s-patterns]]. |

## Cross-package Dependencies

The dependency flow is strictly directional:

- `shared/*` packages have no intra-workspace dependencies (they are consumed by everything)
- `osn/*` packages depend on `shared/*` but never on `musubi/*`, `pulse/*`, `zap/*` or `cire/*`
- `musubi/*` packages depend on `osn/*` and `shared/*` — Musubi is a consumer of OSN, never the reverse
- `pulse/*` packages may depend on `osn/*` (through `graphBridge`) and `shared/*`
- `zap/*` packages may depend on `osn/*` (for identity verification) and `shared/*`
- `cire/*` packages depend on `shared/*` (and `@cire/api`/`@cire/invites` on the intra-stack `@cire/db` / `@cire/theme` / `@cire/ui`) but never on `pulse/*` or `zap/*`
- `pulse/*` and `zap/*` never depend on each other directly

Cross-domain access (e.g. Pulse reading OSN's social graph) goes through a bridge module — see [[s2s-patterns]].

## Native apps (iOS)

Platform priority is iOS, then web, then Android (deferred). The iOS apps are Swift:

- **One local SPM package**, `shared/swift/OSNShared`, with four library products — `OSNKit`, `OSNAuth`, `OSNUI`, `OSNTesting`. Consumers depend on `.product(name: "OSNKit", package: "OSNShared")`.
- **App targets are thin.** All code lives in the package. Each `*.xcodeproj` is generated by XcodeGen from a committed `project.yml` and is gitignored.
- **Every target must compile against the macOS SDK too.** SPM sets `platforms:` per package, not per target, and `swift test` builds every target on the host, so a bare `import UIKit` anywhere in `OSNShared` fails CI. SwiftUI and Liquid Glass exist on macOS 26; code that genuinely needs UIKit goes behind `#if canImport(UIKit)` or into the app target.

## Tech Stack

Bun, TypeScript, Elysia, Effect v4 (backend only), Drizzle, SQLite locally and Cloudflare D1 in the deployed tiers (a Supabase Postgres migration is deferred — an open decision issue in `englishstventures/osn`), Eden+REST, WebSockets, Signal Protocol (planned), SolidJS, Astro, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest.

## Source Files

- [package.json](../../package.json) — root workspace configuration
