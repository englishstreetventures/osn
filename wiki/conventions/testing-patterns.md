---
title: Testing Patterns
description: Test conventions, patterns, and examples for the OSN monorepo
tags: [convention, testing]
related:
  - "[[backend-patterns]]"
  - "[[schema-layers]]"
  - "[[commands]]"
last-reviewed: 2026-08-30
---

# Testing Patterns

## Directory Layout

Test files live in `tests/` at the package root and mirror the `src/` structure:

```
pulse/api/
  tests/
    helpers/db.ts                  # createTestLayer() -- shared test utility
    services/events.test.ts        # Effect service tests
    routes/events.test.ts          # HTTP integration tests
osn/api/
  tests/
    helpers/db.ts                  # createTestLayer() for osn/db (accounts, profiles, passkeys, sessions)
    services/auth.test.ts          # Effect service tests
    routes/auth.test.ts            # HTTP integration tests
pulse/db/
  tests/
    schema.test.ts                 # Schema smoke tests
osn/ui/
  tests/
    auth/Register.test.tsx          # Shared Register component (Solid + happy-dom)
    auth/SignIn.test.tsx            # Shared SignIn component (passkey-only)
    auth/RecoveryLoginForm.test.tsx # Lost-passkey recovery flow
    auth/StepUpDialog.test.tsx      # Sudo-token ceremony for sensitive actions
    auth/SessionsView.test.tsx      # Session list / revoke
    auth/PasskeysView.test.tsx      # Passkey management
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

- **OSN auth routes use `createAuthRoutes(authConfig, dbLayer?)`.** The `authConfig` parameter is required (no global default). `dbLayer` defaults to `DbLive`.

- **Use `bunx --bun vitest`** (not plain `vitest`) -- the flag is required for `bun:sqlite` module access. The `test:run` scripts in `package.json` already set it.

- **Use future dates for test events.** For example, `2030-06-01T10:00:00.000Z`. The default `listEvents` implementation filters out past events, so tests with past dates will produce confusing empty results.

- **Never hand-write a DDL mirror.** Test databases are built from the live Drizzle schema via `applySchema()` (`@osn/db/testing`, `@pulse/db/testing`, `@zap/db/testing`) — never a `CREATE TABLE` string in a helper or a test file. A hand-written mirror makes constraint tests tautological: they assert the `UNIQUE` the author typed a few lines above, not the one the schema declares, so dropping `.unique()` from `src/schema` leaves them green. See [[#Schema-derived test databases]].

- **A test must fail for the reason it is named.** Before landing a test that asserts a side effect (a row written, a notice sent), break the code path and confirm the test goes red. `expect(true).toBe(true)` after an action asserts nothing.

- **Every Solid Vitest config names `shared/test-config/no-jest-dom.ts` in `setupFiles`.** `vite-plugin-solid` prepends `@testing-library/jest-dom/vitest` to `setupFiles` for every run, and only two things stop it — one of your own `setupFiles` paths matching the regex `/jest-dom/` (`getJestDomExport` in the plugin's `dist/esm/index.mjs`), or a browser-mode project, which it skips because Vitest's browser assertions carry the matchers already. That file is a marker whose whole job is to match the regex. It exports nothing and must stay that way; a package that wants real shared setup adds a second entry of its own. Since 2026-08 all 13 configs that import the plugin carry it, and `bun run check:jest-dom-markers` (the `Scripts` CI job) fails the build if one loses it. The guard is per **file**, not per project: `cire/host`'s browser project has no `setupFiles` and still takes the injection, which is harmless there because that package imports the matchers in eighteen files anyway.

- **Import the matchers where you assert with them, and declare the dependency only there.** A test that uses `toHaveAttribute` or `toBeInTheDocument` writes `import "@testing-library/jest-dom/vitest";` at the top of the file, and its package lists `@testing-library/jest-dom` in `devDependencies`. Three packages do — `cire/host`, `cire/vendor` and `pulse/web`. Ten others declared it while importing no matcher and were pruned. Bun's install layout is not hoisted, so an undeclared dependency is unresolvable rather than quietly satisfied: the failure is a red `Cannot find module`, not a green suite. `tsconfig.json` already has the test files in `include`, so the matcher types resolve across a package from any one import. `tools/lab` is the deliberate exception — it leaves the plugin out entirely, so nothing injects and it needs no marker; the guard matches the import statement rather than the plugin's name so its comment about the plugin does not trip it.

## Schema-derived test databases

Every DB package exports an emitter that builds `CREATE TABLE`/`CREATE INDEX` from the live Drizzle schema:

```typescript
import { applySchema } from "@osn/db/testing"; // or @pulse/db, @zap/db

const sqlite = new Database(":memory:");
applySchema(sqlite);
```

Adding a column is then a one-file change in `src/schema/`. The emitter carries column-level `.unique()` (via `col.isUnique`), partial-index `WHERE` clauses, and foreign-key `ON DELETE`/`ON UPDATE` actions — all three were silently dropped before 2026-08, so tests ran on a shape production D1 rejects. The emitted array is memoised and frozen: the schema is a static module import, so reflecting it per test database was pure recomputation.

`osn/db/tests/ddl-lockstep.test.ts` diffs a normalised structural snapshot of the emitted schema against the full `osn/db/drizzle/*.sql` migration chain. It compares columns, types, defaults, nullability, indexes (**including column order within an index** — SQLite serves only a leading prefix), partial predicates, foreign keys and their referential actions, and pins CHECK/trigger/view sets as empty. It fails when a migration lands without a schema change, when a schema change lands without a migration, or when the emitter loses a constraint. `zap/db` has the same test; `cire/api/src/db/ddl-lockstep.test.ts` covers cire's three-way mirror.

**If you extend one emitter, extend all three** — they are copies, and all three (`osn/db`, `pulse/db`, `zap/db`) now carry the lockstep test.

Writing pulse's found **D-H1**: a `user_id` → `profile_id` rename had reached `src/schema` without ever reaching migration `0000`, and three `events` columns existed with no migration at all — so `wrangler d1 migrations apply pulse-db` against a fresh D1 would have failed. Every Pulse test builds from `applySchema()`, so nothing exercised the chain until this test did.

When you write one of these, prove it can fail. Mutate the emitter — drop a constraint, reverse an index's columns — and confirm the test goes red. The first version of the osn test passed with every foreign key removed and with composite index columns reversed.

## Shared test harnesses

Reach for these before hand-rolling setup:

| Harness | Use for |
|---|---|
| `@shared/crypto/testing` → `makeAccessTokenSigner()` | ES256 OSN access tokens (`aud: "osn-access"`, 5-minute `exp` matching production). Returns `{ privateKey, publicKey, sign(profileId, claims?) }`; `claims` covers `email`, `audience`, `expiresIn`, `issuer`, `kid` for negative tests. Used by the pulse, zap and cire route suites. |
| `cire/api/src/test-helpers/osn-token.ts` → `makeOsnTestAuth()` | The cire-shaped `{ key, sign }` adapter over the above. |
| `cire/api/src/test-helpers.ts` → `appRequest()` | Elysia requests with `cf-connecting-ip` + `Origin` pre-injected. |
| `cire/host/src/test-support/mocks.ts` | The `@shared/rp-auth/solid` + `@shared/toast` + `lib/api` mock trio, their spies, and `resetOrganiserMocks()`. |
| `pulse/web/tests/helpers/toast.ts` → `toastMock()` | Same idea for the Pulse app. |

Call `makeAccessTokenSigner()` once per suite in `beforeAll` — there is no reason to re-key per test.

`vi.mock` is hoisted per module, so registration stays in the test file; only the factory body is shared. Use the dynamic-import form so the factory never reads an uninitialised binding:

```typescript
vi.mock("../lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

afterEach(() => {
  cleanup();
  resetOrganiserMocks(); // the spies are module singletons — reset every one
});
```

Because the spies are shared, a `describe` block that forgets a reset inherits call counts from the block above it. Always call `resetOrganiserMocks()` rather than hand-listing the spies you happen to remember.

A suite that genuinely needs a different shape (an extra `useAuth` field, an `importOriginal` spread) keeps its own local mock. These harnesses cover the common case; they are not a mandate.

## The D1 integration lane

Each API package has a `src/d1-integration.test.ts` that runs against a real workerd-backed D1 via Miniflare. These files sit **outside** the vitest `include` glob (`tests/**/*.test.ts`), so `bun run test` never reaches them — they are the only coverage of the **asynchronous** D1 driver that dev/staging/prod actually use, as opposed to the synchronous `bun:sqlite` every other suite runs on.

```bash
bun run test:d1            # all four packages, serially
bun run --cwd zap/api test:d1
```

Run serially. Concurrent Miniflare workerd instances contend and fail spuriously, which is why the root script pins `--concurrency=1`. Both `ci.yml` and `deploy.yml` run this lane; before 2026-08 neither did, and zap's test sat failing on a stale fixture for as long as it took someone to run it by hand.

## Testing an oxlint rule

`tools/oxlint/house` holds the repo's own oxlint rules, and its tests are the odd
one out: they run under `bun test`, not vitest, and they lint fixtures instead of
calling a function.

`@oxlint/plugins` ships no `RuleTester` — the package is four files and exports
`definePlugin`, `defineRule` and `eslintCompatPlugin`, nothing else. So a rule
test writes its fixtures to a temp directory along with a config that enables
that one rule, runs the real `oxlint` binary over them, and asserts on the JSON:

```jsonc
{
  "diagnostics": [
    {
      "message": "…",
      "code": "house(no-in-operator-key-guard)",
      "severity": "error",
      "filename": "/abs/path/bad.ts",
      "labels": [{ "span": { "offset": 118, "length": 12, "line": 4, "column": 9 } }]
    }
  ]
}
```

Four things about that output are worth knowing before you write assertions:

- **`code` is `plugin(rule)`**, not `plugin/rule` — the config key and the
  diagnostic code are spelled differently.
- **`filename` is absolute**, so match on the basename.
- **oxlint exits non-zero when it finds anything.** Read stdout and ignore the
  exit code; treating it as failure makes every red fixture look like a crashed
  run.
- **The plugin `specifier` in the temp config must be an absolute path.** The
  `cwd` may be the temp directory: `@oxlint/plugins` resolves from the plugin
  file's own location, not the config's.

Turning the whole `correctness` category off in that config (`"categories":
{"correctness": "off"}`, `"plugins": []`) is what keeps a fixture's other
problems out of the result, so the assertion is about the rule under test.

Fixtures earn their place by pinning a decision. `no-in-operator-key-guard`
matches the parameter a type predicate narrows, not the literal
`is keyof typeof MAP` syntax, so it carries a fixture for the aliased form the
repo actually contains — and negative fixtures for `#brand in value` and for a
string-literal discriminant, both of which are also `in` inside a predicate and
both of which must stay silent.

The rule itself is wired into `oxlintrc.json` as a second `jsPlugins` entry, so
`bun run lint` runs it over the whole repo like any published rule.

## Running Tests

```bash
# All tests
bun run test

# Package-specific (run once)
bun run --cwd pulse/api test:run
bun run --cwd osn/api test:run
bun run --cwd osn/client test:run
bun run --cwd osn/ui test:run
bun run --cwd pulse/db test:run
bun run --cwd zap/api test:run
bun run --cwd zap/db test:run

# Watch mode
bun run --cwd pulse/api test
```

## Related

- [[backend-patterns]] -- service and route layer architecture
- [[schema-layers]] -- Elysia TypeBox vs Effect Schema
- [[commands]] -- full CLI reference
