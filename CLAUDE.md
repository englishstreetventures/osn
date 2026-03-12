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
  landing/             # ✓ Astro + Solid (marketing site)
  pulse/               # ✓ Tauri + SolidJS (iOS target ready)
    src/               # SolidJS frontend
    src-tauri/         # Rust + Tauri native layer
  osn/                 # Pending: bunx create-tauri-app
  messaging/           # Pending: bunx create-tauri-app
packages/
  api/                 # ✓ Elysia + Eden
  db/                  # ✓ Drizzle + SQLite
  ui/                  # ✓ Placeholder (shared components)
  core/                # ✓ Placeholder (shared business logic)
  crypto/              # ✓ Placeholder (Signal protocol)
  typescript-config/   # ✓ base, node, solid configs
```

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite→Supabase, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Valibot, Vitest + @effect/vitest

## Conventions

- Tauri apps created via CLI (`bunx create-tauri-app`), not manually
- Effect.ts: trial with OSN/Pulse first, then decide (see TODO.md)
- Messaging backend is shared service (direct/indirect modes)
- E2E encryption everywhere
- All personalization data user-accessible + resettable
- Priority: iOS > Web > Android (Android deferred)
- Pre-commit: lefthook runs oxlint + oxfmt on staged files
- Pre-push: lefthook runs type check
- oxlint configured via `oxlintrc.json` (React plugin disabled for SolidJS)
- Use `bunx --bun` flag for all tooling (bypasses Node.js)

## Testing Patterns

Test files live in `tests/` at the package root, mirroring the `src/` structure:

```
packages/api/
  tests/
    helpers/db.ts                  # createTestLayer() — shared test utility
    services/events.test.ts        # Effect service tests
    routes/events.test.ts          # HTTP integration tests
packages/db/
  tests/
    schema.test.ts                 # Schema smoke tests
```

```typescript
// Service tests: it.effect from @effect/vitest, isolated DB per test
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";

it.effect("creates event with evt_ prefix", () =>
  Effect.gen(function* () {
    const event = yield* createEvent({ title: "Test", startTime: "2030-06-01T10:00:00.000Z" });
    expect(event.id).toMatch(/^evt_/);
  }).pipe(Effect.provide(createTestLayer()))
);

// Error assertions: use Effect.flip to promote errors to success channel
it.effect("fails with EventNotFound", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(getEvent("nonexistent"));
    expect(error._tag).toBe("EventNotFound");
  }).pipe(Effect.provide(createTestLayer()))
);

// Route tests: plain vitest, fresh app per test via beforeEach
import { describe, it, expect, beforeEach } from "vitest";
import { createEventsRoutes } from "../../src/routes/events";

describe("events routes", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  beforeEach(() => { app = createEventsRoutes(createTestLayer()); });

  it("GET /events → 200", async () => {
    const res = await app.handle(new Request("http://localhost/events"));
    expect(res.status).toBe(200);
  });
});
```

**Rules:**
- All tests use in-memory SQLite — no file DB, no migrations needed
- Service tests: `it.effect` + `Effect.provide(createTestLayer())` per test (full isolation)
- Route tests: `createEventsRoutes(createTestLayer())` in `beforeEach` (full isolation)
- Routes accept an optional `dbLayer` param for injection; default is `DbLive`
- Use `bunx --bun vitest` (not plain `vitest`) — required for `bun:sqlite` module access
- Use future dates (e.g. `2030-06-01T10:00:00.000Z`) for test events; default `listEvents` filters past events out

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

# Testing
bun run test                          # run all tests (turbo, skips packages without test script)
bun run --cwd packages/api test:run   # run API tests once
bun run --cwd packages/db test:run    # run db schema tests once
bun run --cwd packages/api test       # watch mode

# Code quality
bun run lint             # oxlint
bun run fmt              # oxfmt format
bun run fmt:check        # oxfmt check (CI)

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
