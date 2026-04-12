# CLAUDE.md

AI coding assistant reference. For full spec see README.md. For progress/decisions see `wiki/TODO.md`.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

Phase 1 apps: OSN Core (auth), Pulse (events), Zap (messaging), Landing (marketing).

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → AI entry point: quick context, conventions, commands, and wiki navigation
- `wiki/TODO.md` → Progress tracking, deferred decisions, task checklists
- `wiki/` → Obsidian knowledge graph: architecture, systems, observability, runbooks
  - Open in Obsidian for graph view; or navigate via `[[wiki links]]` from this file
  - See `[[wiki/index]]` for the full map of content

## TODO.md Structure + Maintenance

`wiki/TODO.md` is organised into these top-level sections — add new items to the right place:

| Section | What goes here |
|---------|---------------|
| **Up Next** | ≤8 highest-priority items across all areas. Keep it short — if everything is a priority, nothing is. Prune when items are done or promoted to a feature section. |
| **App sections** (Pulse, OSN Core, Zap, Landing) | Feature work specific to that app. Check items off when done; don't delete them. |
| **Platform** (API, DB, Client, UI, Infra) | Shared package work and infrastructure. Same check-off rule. |
| **Security Backlog** | All security findings, sorted H → M → L. Add new findings from PR reviews here. Mark done with `[x]` + short note. Never delete — the history matters. |
| **Performance Backlog** | All perf findings. Same rules as Security. |
| **Deferred Decisions** | Questions we're not answering yet. Add a row; remove it when the decision is made. |
| **Future** | Phase 2/3 items. Vague is fine here — detail gets added when the phase starts. |

**When to update TODO.md:**
- After a PR merges → check off completed items; add any new findings; update Up Next
- When a security/performance review surfaces findings → add to the relevant backlog section with `[[wiki links]]` to affected system pages
- When a new deferred decision comes up → add a row to the table
- Keep Up Next pruned to the real next things — it should be actionable at a glance

## Wiki Navigation

The `wiki/` directory contains detailed reference pages. Use this index to find the right page — only read the pages you need:

| If you need to... | Read |
|---|---|
| Understand the monorepo layout | `[[wiki/architecture/monorepo-structure]]` |
| Write a new Effect service or Elysia route | `[[wiki/architecture/backend-patterns]]`, `[[wiki/architecture/schema-layers]]` |
| Add or verify ARC S2S tokens | `[[wiki/systems/arc-tokens]]` |
| Add rate limiting to an endpoint | `[[wiki/systems/rate-limiting]]` |
| Instrument logging, tracing, or metrics | `[[wiki/observability/overview]]`, then the specific page |
| Write or review tests | `[[wiki/conventions/testing-patterns]]` |
| Understand event visibility rules | `[[wiki/systems/event-access]]` |
| Work on the social graph or close friends | `[[wiki/systems/social-graph]]`, `[[wiki/systems/close-friends]]` |
| Understand cross-service calls | `[[wiki/architecture/s2s-patterns]]` |
| Debug a production issue | Browse `wiki/runbooks/` |
| Check security or perf findings | `wiki/TODO.md` (Security Backlog / Performance Backlog sections) |
| Track progress and priorities | `wiki/TODO.md` |

### Wiki maintenance rules

- **When you add a new system or pattern**, create a wiki page and link it from the table above and from `[[wiki/index]]`.
- **When you modify an existing pattern**, update the corresponding wiki page in the same PR.
- **Every wiki page must have YAML frontmatter** with at least `title`, `tags`, `related`, and `last-reviewed` fields.
- **Use `[[wiki links]]`** to connect pages inside `wiki/`; never use relative markdown links between wiki pages.
- **Security/performance findings** in `wiki/TODO.md` should include `[[wiki links]]` to the affected system pages (e.g., `[[rate-limiting]]`, `[[arc-tokens]]`).
- **Update `last-reviewed`** in frontmatter of any wiki page you touch.

## Current State (summary)

Monorepo organised by domain. Four directories, four prefixes — see `[[wiki/architecture/monorepo-structure]]` for the full tree.

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/` | `@osn/*` | Identity stack (auth, graph, SDK, crypto, landing) |
| `pulse/` | `@pulse/*` | Events stack (app, API, DB) |
| `zap/` | `@zap/*` | Messaging stack (placeholder) |
| `shared/` | `@shared/*` | Cross-cutting utilities |

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite→Supabase, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest

## Key Patterns (summaries)

**ARC Tokens** — S2S auth via self-issued ES256 JWTs. Lives in `@osn/crypto/arc`. See `[[wiki/systems/arc-tokens]]`.

**Observability** — OpenTelemetry end-to-end, shipped to Grafana Cloud. Three golden rules: no `console.*`, no raw OTel constructors, no unbounded metric attributes. See `[[wiki/observability/overview]]`.

**Rate Limiting** — Per-IP fixed-window on all auth endpoints; per-user on graph writes. Two backends: Redis-backed when `REDIS_URL` is set (cross-process, survives restarts), in-memory fallback when unset (local dev). See `[[wiki/systems/rate-limiting]]`, `[[wiki/systems/redis]]`.

**Testing** — `it.effect` + `createTestLayer()` for service tests; `createXxxRoutes(createTestLayer())` for route tests. All in-memory SQLite. See `[[wiki/conventions/testing-patterns]]`.

**Schema Layers** — Elysia TypeBox at HTTP boundary, Effect Schema in service layer. Never mix. See `[[wiki/architecture/schema-layers]]`.

**Review Finding IDs** — S-C/H/M/L (security), P-C/W/I (performance), T-M/U/E/R/S (tests). Four-field format. See `[[wiki/conventions/review-findings]]`.

## Conventions

- Tauri apps created via CLI (`bunx create-tauri-app`), not manually
- Effect.ts: trial with OSN/Pulse first, then decide (see TODO.md)
- Messaging backend (`@zap/api`) is a shared service: Zap consumes it directly; Pulse uses it indirectly for event chats. Users don't need a Zap install to participate in event group chats.
- E2E encryption everywhere
- All personalization data user-accessible + resettable
- Priority: iOS > Web > Android (Android deferred)
- Pre-commit: lefthook runs oxlint + oxfmt on staged files
- Pre-push: lefthook runs type check
- oxlint configured via `oxlintrc.json` (React plugin disabled for SolidJS)
- Use `bunx --bun` flag for all tooling (bypasses Node.js)
- PRs required to merge to main (no direct pushes)
- Always work on a feature branch — never commit directly to main
- Every PR must include a changeset (`bun run changeset`) — CI will fail without one
- **Changeset packages must use the workspace `name` field exactly** (e.g. `"@pulse/app"`, not `"pulse"`). The Changeset Check workflow runs `bunx changeset status` to catch typos before merge — without it, a bad reference fails the Release workflow on main and blocks all subsequent versioning.
- Versioning is automatic: changesets are consumed and committed by CI on merge to main

## Commands

```bash
# Development
bun run dev              # Start all dev servers (turbo)
bun run build            # Build all packages (turbo)
bun run check            # Type-check all packages (turbo)

# Testing
bun run test                          # run all tests (turbo, skips packages without test script)
bun run --cwd pulse/api test:run          # run Pulse events API tests once
bun run --cwd osn/core test:run           # run OSN core auth tests once
bun run --cwd osn/client test:run         # run OSN client SDK tests once
bun run --cwd osn/ui test:run             # run shared auth component tests once
bun run --cwd pulse/db test:run           # run Pulse DB schema tests once
bun run --cwd pulse/api test              # watch mode

# Code quality
bun run lint             # oxlint
bun run fmt              # oxfmt format
bun run fmt:check        # oxfmt check (CI)

# Database (run from the relevant package directory)
bun run db:migrate       # Generate migrations
bun run db:push          # Push schema
bun run db:studio        # Drizzle Studio
# e.g. bun run --cwd pulse/db db:studio

# Versioning
bun run changeset        # Create changeset (required for every PR)
# Note: bun run version runs automatically on merge to main — do not run manually

# Maintenance
bun run clean            # git clean -fdX
bun run reset            # clean + reinstall

# Tauri (from app directory)
bunx tauri init          # Initialize app
bunx tauri dev           # Dev server
bunx tauri build         # Build app
```

## Workspace Installs

```bash
# Use --cwd (not --filter)
bun add solid-js --cwd osn/landing
bun add drizzle-orm --cwd pulse/db
```
