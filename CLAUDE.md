# CLAUDE.md

AI coding assistant reference. For full spec see README.md. For progress/decisions see TODO.md.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

Phase 1 apps: OSN Core (auth), Pulse (events), Messaging (TBD name), Landing (marketing).

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → Code patterns, commands, current state, conventions (AI reference)
- `TODO.md` → Progress tracking, deferred decisions, task checklists

## Current State

```
apps/
  landing/             # ✓ Astro + Solid
  osn/                 # Pending: bunx tauri init
  pulse/               # Pending: bunx tauri init
  messaging/           # Pending: bunx tauri init
packages/
  api/                 # ✓ Elysia + Eden
  db/                  # ✓ Drizzle + SQLite
  ui/                  # ✓ Placeholder
  core/                # ✓ Placeholder
  crypto/              # ✓ Placeholder
  typescript-config/   # ✓ base, node, solid configs
```

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite→Supabase, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Valibot

## Conventions

- Tauri apps created via CLI (`bunx tauri init`), not manually
- Effect.ts: trial with OSN/Pulse first, then decide (see TODO.md)
- Messaging backend is shared service (direct/indirect modes)
- E2E encryption everywhere
- All personalization data user-accessible + resettable
- Priority: iOS > Web > Android (Android deferred)

## Backend Code Patterns

```typescript
// Path aliases: use # prefix
import { schema } from "#db";
import { Context } from "#routes/context";

// Route organization: group by domain, separate handlers
export const routes = new Elysia()
  .state("ctx", createContext())
  .group("/events", routes => routes
    .get("/:id", ({ store: { ctx }, params }) => getEvent(ctx, params))
    .post("/", ({ store: { ctx }, body }) => createEvent(ctx, body))
  );

// Handlers: pure functions with context injection
export const getEvent = (ctx: Context, params: { id: string }) =>
  ctx.db.select().from(schema.events).where(eq(schema.events.id, params.id));

// Validation: valibot parse before db ops
const validated = parse(insertEventSchema, body);
```

tsconfig paths: `#db` → `./src/db`, `#routes` → `./src/routes`

## Commands

```bash
# Development
bun run dev              # Start all dev servers (turbo)
bun run build            # Build all packages (turbo)
bun run check            # Type-check all packages (turbo)

# Code quality
bun run lint             # oxlint
bun run fmt              # oxfmt

# Database (from packages/db)
bun run db:migrate       # Generate migrations
bun run db:push          # Push schema
bun run db:studio        # Drizzle Studio

# Versioning
bun run changeset        # Create changeset
bun run version          # Version packages

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
bun add solid-js --cwd apps/landing
bun add drizzle-orm --cwd packages/db
```
