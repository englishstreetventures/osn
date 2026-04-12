---
title: Testing Patterns
description: Test conventions, patterns, and examples for the OSN monorepo
tags: [convention, testing]
---

# Testing Patterns

## Directory Layout

Test files live in `tests/` at the package root, mirroring the `src/` structure:

```
pulse/api/
  tests/
    helpers/db.ts                  # createTestLayer() -- shared test utility
    services/events.test.ts        # Effect service tests
    routes/events.test.ts          # HTTP integration tests
osn/core/
  tests/
    helpers/db.ts                  # createTestLayer() for osn/db (users + passkeys)
    services/auth.test.ts          # Effect service tests
    routes/auth.test.ts            # HTTP integration tests
pulse/db/
  tests/
    schema.test.ts                 # Schema smoke tests
osn/ui/
  tests/
    auth/Register.test.tsx         # Shared Register component (Solid + happy-dom)
    auth/SignIn.test.tsx            # Shared SignIn component
    auth/MagicLinkHandler.test.tsx  # Magic-link deep-link helper
```

## Service Test Pattern

Service tests use `it.effect` from `@effect/vitest` with an isolated DB per test via `Effect.provide(createTestLayer())`.

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
```

### Error Assertion Pattern

Use `Effect.flip` to promote errors to the success channel for assertion:

```typescript
// Error assertions: use Effect.flip to promote errors to success channel
it.effect("fails with EventNotFound", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(getEvent("nonexistent"));
    expect(error._tag).toBe("EventNotFound");
  }).pipe(Effect.provide(createTestLayer()))
);
```

## Route Test Pattern

Route tests use plain vitest with a fresh app per test via `beforeEach`:

```typescript
// Route tests: plain vitest, fresh app per test via beforeEach
import { describe, it, expect, beforeEach } from "vitest";
import { createEventsRoutes } from "../../src/routes/events";

describe("events routes", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  beforeEach(() => { app = createEventsRoutes(createTestLayer()); });

  it("GET /events -> 200", async () => {
    const res = await app.handle(new Request("http://localhost/events"));
    expect(res.status).toBe(200);
  });
});
```

## Rules

- **All tests use in-memory SQLite** -- no file DB, no migrations needed. Each test gets a fresh database via `createTestLayer()`.

- **Service tests: `it.effect` + `Effect.provide(createTestLayer())` per test.** Every test gets full isolation. Never share state between tests.

- **Route tests: `createXxxRoutes(createTestLayer())` in `beforeEach`.** Full isolation per test. The route factory accepts an optional `dbLayer` param for injection; the default is `DbLive`.

- **OSN Core auth routes use `createAuthRoutes(authConfig, dbLayer?)`.** The `authConfig` parameter is required (no global default). `dbLayer` defaults to `DbLive`.

- **Use `bunx --bun vitest`** (not plain `vitest`) -- required for `bun:sqlite` module access. The `test:run` scripts in `package.json` are already configured correctly.

- **Use future dates for test events.** For example, `2030-06-01T10:00:00.000Z`. The default `listEvents` implementation filters out past events, so tests with past dates will produce confusing empty results.

## Running Tests

```bash
# All tests
bun run test

# Package-specific (run once)
bun run --cwd pulse/api test:run
bun run --cwd osn/core test:run
bun run --cwd osn/client test:run
bun run --cwd osn/ui test:run
bun run --cwd pulse/db test:run

# Watch mode
bun run --cwd pulse/api test
```

## Related

- [[backend-patterns]] -- service and route layer architecture
- [[schema-layers]] -- Elysia TypeBox vs Effect Schema
- [[commands]] -- full CLI reference
