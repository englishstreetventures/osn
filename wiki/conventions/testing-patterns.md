---
title: Testing Patterns
description: Test conventions, patterns, and examples for the OSN monorepo
tags: [convention, testing]
related:
  - "[[backend-patterns]]"
  - "[[schema-layers]]"
  - "[[commands]]"
  - "[[bundle-size-guards]]"
last-reviewed: 2026-09-23
---

# Testing Patterns

## Directory Layout

Test files live in `tests/` at the package root and mirror the `src/` structure. **Every**
package, without exception — `cire/*`, the three landing sites and `scripts/` all kept their
tests beside the source until 2026-09-01, and no longer do. Test-only support code (mocks,
fixtures, request harnesses) lives under `tests/` too, never in `src/`:

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
cire/api/
  tests/
    test-helpers.ts                # appRequest() -- Elysia request harness
    test-helpers/osn-token.ts      # makeOsnTestAuth()
    routes/rsvp.test.ts            # HTTP integration tests
    db/d1-integration.test.ts      # Miniflare tier -- see The D1 integration lane
cire/host/
  tests/
    test-support/mocks.ts          # shared Solid mocks for the organiser portal
    components/Overview.test.tsx   # unit tier (happy-dom)
    components/ImportPanel.browser.test.tsx  # browser tier (real Chromium)
scripts/
  tests/
    check-astro-fonts.test.ts      # scripts/ is not a workspace; `bun test ./scripts/`
    changeset-required.test.sh     # shell tests too
shared/ui/
  tests/
    test-support/browser-commands.ts # Vitest browser commands (emulateMedia)
    lib/utils.test.ts                # cn() / clsx()
    ui/otp-input.test.tsx            # unit tier (happy-dom) -- DOM shape and class lists
    modal.browser.test.tsx           # browser tier (real Chromium) -- top layer, focus trap, ::backdrop
osn/auth-ui/
  tests/
    SignIn.test.tsx                 # passkey-only sign-in view
    Register.test.tsx               # registration view
    RecoveryLoginForm.test.tsx      # lost-passkey recovery flow
    StepUpDialog.test.tsx           # sudo-token ceremony for sensitive actions
    SessionsView.test.tsx           # session list / revoke
    PasskeysView.test.tsx           # passkey management
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

### Reading the error out of an `Exit` (Effect v4)

`Effect.flip` is the first choice because it needs no unwrapping. When a test
holds an `Exit` instead — from `runPromiseExit`, or a helper that returns one —
read the error with `Cause.findErrorOption`. v4's `Cause` is a flat list of
reasons, so there is no `Fail` node to match on and the v3 form does not
type-check:

```typescript
// v3: exit.cause._tag === "Fail" && exit.cause.error instanceof VendorNotInWedding
expect(
  Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof VendorNotInWedding,
).toBe(true);
```

`findErrorOption` returns `None` for a **defect**, so this refuses one exactly
as the `_tag === "Fail"` check did — a test that should be catching a typed
failure does not quietly start passing on a crash.

Three more v4 facts that decide whether an assertion is real:

- **`Effect.runPromise` rejects with `Cause.squash(cause)`**, which for a typed
  failure is the error instance itself. v3 wrapped it in a `FiberFailure` whose
  prototype was not the error class, so tests written then may assert
  `instanceof` is `false`. Under v4 it is `true`.
- **`Either` is `Result`**, and its tags are `"Success"`/`"Failure"`, not
  `"Right"`/`"Left"`. `expect(x._tag).toBe("Right")` compiles fine against
  `toBe`'s `any` and simply never matches, so it fails as a puzzling assertion
  rather than a type error.
- **`@effect/vitest`'s `assertFailure` changed meaning**: in v3 it asserted on
  an `Exit`, in v4 it asserts a `Result.Failure`, and the v3 behaviour moved to
  `assertExitFailure`. This repo uses neither, so nothing here is exposed — but
  a helper added from a v3 example would be asserting something else.

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

- **A test must fail for the reason it is named.** Before landing a test that asserts a side effect (a row written, a notice sent), break the code path and confirm the test goes red. `expect(true).toBe(true)` after an action asserts nothing. Three ways that check is passed by a test which still cannot fail — a timestamp tie, a `waitFor`ed absence, and a red-proof that ate its own fix — are in [[#Assertions that cannot fail]].

- **Every Solid Vitest config names `shared/test-config/no-jest-dom.ts` in `setupFiles`.** `vite-plugin-solid` prepends `@testing-library/jest-dom/vitest` to `setupFiles` for every run, and only two things stop it — one of your own `setupFiles` paths matching the regex `/jest-dom/` (`getJestDomExport` in the plugin's `dist/esm/index.mjs`), or a browser-mode project, which it skips because Vitest's browser assertions carry the matchers already. That file is a marker whose whole job is to match the regex. It exports nothing and must stay that way; a package that wants real shared setup adds a second entry of its own. Since 2026-08 all 13 configs that import the plugin carry it, and `bun run check:jest-dom-markers` (the `Scripts` CI job) fails the build if one loses it. The guard is per **file**, not per project: `cire/host`'s browser project has no `setupFiles` and still takes the injection, which is harmless there because that package imports the matchers in eighteen files anyway.

- **Import the matchers where you assert with them, and declare the dependency only there.** A test that uses `toHaveAttribute` or `toBeInTheDocument` writes `import "@testing-library/jest-dom/vitest";` at the top of the file, and its package lists `@testing-library/jest-dom` in `devDependencies`. Three packages do — `cire/host`, `cire/vendor` and `pulse/web`. Ten others declared it while importing no matcher and were pruned. Bun's install layout is not hoisted, so an undeclared dependency is unresolvable rather than quietly satisfied: the failure is a red `Cannot find module`, not a green suite. `tsconfig.json` already has the test files in `include`, so the matcher types resolve across a package from any one import. `tools/lab` is the deliberate exception — it leaves the plugin out entirely, so nothing injects and it needs no marker; the guard matches the import statement rather than the plugin's name so its comment about the plugin does not trip it.

## Assertions that cannot fail

[[#Rules]] says a test must fail for the reason it is named. This is the
catalogue of how that goes wrong here. Every entry below was found by
deliberately breaking the code and watching the test stay green — never by
reading it. One epic produced four such tests and four destroyed fixes from
these three causes alone.

### Tautological tests

A tautological test passes whatever the code under test does, because it checks the test against itself. Do not write one; `review-tests` reports each as an untested export. The shapes:

- asserting what a mock or fixture was just told to return, with none of our code in between;
- computing the expected value by calling the function under test, or copying its formula;
- asserting a hand-written mirror — a `CREATE TABLE` string, a list typed out beside the constant it claims to check (see [[#Rules]] on DDL mirrors);
- an assertion that cannot be false: `expect(true)`, `toBeDefined()` on a value just built, a snapshot of a mock;
- asserting only that a mock was called, not what the call did.

The check is the same as for the entries below: break the line the test names, and it must go red.

### `created_at` is unix seconds, so rows written together tie

Four separate false greens in one epic, all the same shape.

A helper picked "the newest row" by sorting `created_at`. Two credentials
enrolled in the same second tied, so the test read the *parent's* value and
asserted it against the child — and an implementation that did the wrong thing
passed the one test written to catch it. Elsewhere every fixture was backdated,
so `<` and `<=` agreed on every row and a boundary went untested until a
same-second case was added.

Two rules follow:

- **Order by something exact.** Where a decision comes down to which row is
  newer, break the tie on an id the code already returns, not on the timestamp.
  A test that seeds two rows and expects a particular one to win must make the
  ordering explicit rather than hope the clock separates them.
- **Pass one `Date`, not two `new Date()` calls.** A tie test that calls
  `new Date()` twice is hoping both land in the same second. Build the value
  once and hand it to both seeds.

And where a comparison could flip — `<` against `<=` — seed the exact-equal
case. That is the only row on which the two operators disagree.

### `waitFor` calls its callback synchronously on the first attempt

`@testing-library/dom` runs the callback once, immediately, before yielding. So
this passes before anything has rendered:

```ts
// Green whether or not the guard exists.
await waitFor(() => expect(screen.queryByRole("button", { name: X })).toBeNull());
```

`toBeNull()` is already true on an empty document, `waitFor` resolves on the
spot, and a resource that would have rendered the button never gets a tick to
settle. Wrapping a racy absence check in `waitFor` is the same bug with more
ceremony — two such assertions were confirmed green 5/5 and 3/3 runs against a
deliberately reintroduced bug.

**Mount the case under test beside one that does render the thing**, wait for
that sibling to paint, then assert the absence. The wait then turns on a
condition that starts out false, so it has to observe a real render:

```ts
// The admitting twin is what makes the wait mean something.
renderAdmitting();
renderRefusing();
await vi.waitFor(() => expect(screen.getByRole("button", { name: X })).toBeVisible());
expect(screen.queryAllByRole("button", { name: X })).toHaveLength(1);
```

Under faked timers use `vi.waitFor`, not testing-library's — the latter schedules
against the `setTimeout` the fake clock has replaced.

### The seed and the failure result are the same value

A resource seeded with the value its failure path returns cannot be tested by
reading it. `createInviteRevalidation`
(`cire/invites/src/components/invite-revalidation.ts`) passes `fallback()` as
both the `initialValue` and the result of a non-OK response and a thrown fetch,
which is the point of it — a failed revalidation keeps what is painted. So this
is green whether the failure paths exist, map the response instead, or were
deleted:

```ts
// The resource already equals the fallback before the fetch settles.
expect(data()).toEqual(fallback);
```

Three things together make it able to fail, and all three are needed:

- **Wait for the resource to settle** — `await vi.waitFor(() => expect(data.loading).toBe(false))`
  — because the read otherwise happens before the fetcher has resolved.
- **Compare identity against one sentinel** (`toBe`, on a module-level object),
  not shape. `toEqual` cannot tell the seed from a lookalike the success path
  built.
- **Assert the mapper was not called.** A spy on `select` asserted
  `not.toHaveBeenCalled()` is the only thing separating a non-OK response from a
  successful one whose mapping happened to return the same value.

The same shape appears one layer up, in a component seeded from a prop: a test
whose stubbed response is `JSON.stringify(initial)` — the object it passed in —
asserts nothing about whether the component reads the response at all. Give the
response a **different** value and assert the new one wins and the old is gone.
Three of five planned tests and both design packs' headers were caught by this
in one branch.

### An out-of-type fixture that fails the comparison anyway

Feeding garbage to a clamp only tests the clamp if the garbage would otherwise
be visible. `clampNum` in the invite headers drops a non-number to a default,
and the panel it feeds renders only when the value is `> 0`:

```ts
// Green with the clamp, and green with the clamp deleted: "abc" > 0 is false,
// so nothing renders either way.
heroDisplay: { titleBackdrop: { opacity: "abc", blur: 0 } }
```

A **numeric string** is the fixture that can fail — `"60"` renders a 60% panel
if the guard is removed and nothing while it stands. The rule generalises: an
invalid fixture has to be one the broken code would treat as valid, or the test
passes for the wrong reason. Where the value under test is only observable
alongside another (here, a blur that is emitted only when the opacity is
non-zero), the other one has to be valid too.

### Commit before you red-proof

Breaking a guard to watch a test go red is the only way to know the test works.
Restoring with `git checkout -- <path>` while the work is **uncommitted**
restores `origin/main`, not the work — silently deleting the fix being proved.

Four people hit this in one epic. One noticed only because a test count changed;
another only because an unrelated test failed. Nothing announces it.

Commit first, then break, then `git checkout --` restores the commit. If the
change genuinely cannot be committed yet, copy the file aside and restore from
the copy. A read-only reviewer should mutate a copy of the whole worktree
instead — `cp -Rc` is a cheap clone on APFS — which also means an interrupted
review costs nothing.

## Schema-derived test databases

Every DB package exports an emitter that builds `CREATE TABLE`/`CREATE INDEX` from the live Drizzle schema:

```typescript
import { applySchema } from "@osn/db/testing"; // or @pulse/db, @zap/db

const sqlite = new Database(":memory:");
applySchema(sqlite);
```

Adding a column is then a one-file change in `src/schema/`. The emitter carries column-level `.unique()` (via `col.isUnique`), partial-index `WHERE` clauses, and foreign-key `ON DELETE`/`ON UPDATE` actions — all three were silently dropped before 2026-08, so tests ran on a shape production D1 rejects. The emitted array is memoised and frozen: the schema is a static module import, so reflecting it per test database was pure recomputation.

`osn/db/tests/ddl-lockstep.test.ts` diffs a normalised structural snapshot of the emitted schema against the full `osn/db/drizzle/*.sql` migration chain. It compares columns, types, defaults, nullability, indexes (**including column order within an index** — SQLite serves only a leading prefix), partial predicates, foreign keys and their referential actions, and pins CHECK/trigger/view sets as empty. It fails when a migration lands without a schema change, when a schema change lands without a migration, or when the emitter loses a constraint. `zap/db` has the same test; `cire/api/tests/db/ddl-lockstep.test.ts` covers cire's three-way mirror.

**If you extend one emitter, extend all three** — they are copies, and all three (`osn/db`, `pulse/db`, `zap/db`) now carry the lockstep test.

Writing pulse's found **D-H1**: a `user_id` → `profile_id` rename had reached `src/schema` without ever reaching migration `0000`, and three `events` columns existed with no migration at all — so `wrangler d1 migrations apply pulse-db` against a fresh D1 would have failed. Every Pulse test builds from `applySchema()`, so nothing exercised the chain until this test did.

When you write one of these, prove it can fail. Mutate the emitter — drop a constraint, reverse an index's columns — and confirm the test goes red. The first version of the osn test passed with every foreign key removed and with composite index columns reversed.

## Shared test harnesses

Reach for these before hand-rolling setup:

| Harness | Use for |
|---|---|
| `@shared/crypto/testing` → `makeAccessTokenSigner()` | ES256 OSN access tokens (`aud: "osn-access"`, 5-minute `exp` matching production). Returns `{ privateKey, publicKey, sign(profileId, claims?) }`; `claims` covers `email`, `audience`, `expiresIn`, `issuer`, `kid` for negative tests. Used by the pulse, zap and cire route suites. |
| `cire/api/tests/test-helpers/osn-token.ts` → `makeOsnTestAuth()` | The cire-shaped `{ key, sign }` adapter over the above. |
| `cire/api/tests/test-helpers.ts` → `appRequest()` | Elysia requests with `cf-connecting-ip` + `Origin` pre-injected. |
| `cire/host/tests/test-support/mocks.ts` | The `@shared/rp-auth/solid` + `@shared/toast` + `lib/api` mock trio, their spies, and `resetOrganiserMocks()`. |
| `pulse/web/tests/helpers/toast.ts` → `toastMock()` | Same idea for the Pulse app. |
| `cire/api/tests/test-helpers/metrics-harness.ts` → `counterValue()` | Reading a counter back in a `@cire/api` test. See [[#Asserting a metric]]. |

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

## Asserting a metric

A metric test that does not install a meter provider asserts nothing.

`createCounter` (`shared/observability/src/metrics/factory.ts`) resolves its
meter through OpenTelemetry's **global** provider, and with none installed that
is the API's NoOp meter — which accepts every call and records nothing. So a
test written against it passes with the `metric*()` call deleted from the route,
which is the one failure a metric test exists to catch.

> [!warning] The instrument is cached on first use
> `createCounter` builds its instrument on the first `.inc()` and keeps it in a
> closure. A provider installed after that point is never consulted again for
> that counter. `bun test` runs every file in one process, so "first use" is
> process-wide: one earlier file's `.inc()` freezes the NoOp instrument in for
> every file after it.

`@cire/api` solves that with a **preload**, not an import — its `test` script is
`bun test --preload ./tests/test-helpers/metrics-harness.ts`, and a preload runs
before any test file. The harness installs an in-memory `MeterProvider` backed by
an on-demand `MetricReader`, and exports one function:

```typescript
import { counterValue } from "../test-helpers/metrics-harness";
import { CIRE_METRICS } from "../../src/metrics";

const before = await counterValue(CIRE_METRICS.rsvpBlocked, { reason: "dietary_consent" });
await post(body, cookie);
expect(await counterValue(CIRE_METRICS.rsvpBlocked, { reason: "dietary_consent" })).toBe(
  before + 1,
);
```

Three rules come with it:

- **Read a delta, never an absolute.** The reader is cumulative and the provider
  outlives every file in the run, so a counter carries whatever earlier tests
  added. Read before, act, read after, assert the difference.
- **`attrs` is the whole attribute set**, not a subset — a data point is keyed by
  all of its attributes, and a partial match finds nothing.
- **`counterValue` throws** when the installed provider is not the harness's,
  rather than answering `0`. Without that the failure reads "expected 1,
  received 0" with nothing to say the harness never ran.

Running one file directly (`bun test tests/routes/rsvp.test.ts`) works without
the preload, because a file that reads a counter imports the harness and the
instruments are not built until the first `.inc()`. The preload is what makes the
**whole-suite** run safe.

Two things deliberately avoided, both for the same one-process reason:

- **`mock.module`** is global, so a mock of `../../src/metrics` in one file leaks
  into every file that runs after it.
- **`PeriodicExportingMetricReader`** would attach an interval to every run and
  make collection timing the test's problem. `MetricReader.collect()` is public,
  so a subclass with two inert hooks gives an on-demand read and no timer.

Constructing a raw OTel provider is allowed here because it is test code under
`tests/`. Source may still only reach instruments through
`@shared/observability/metrics` — see [[overview]].

`@osn/api`, `@pulse/api` and `@zap/api` have the same blind spot and no harness
yet; their metric suites today assert only that a call does not throw.

## The D1 integration lane

Each API package has a `tests/d1/d1-integration.test.ts` (cire's is `tests/db/d1-integration.test.ts`) that runs against a real workerd-backed D1 via Miniflare. They are the only coverage of the **asynchronous** D1 driver that dev/staging/prod actually use, as opposed to the synchronous `bun:sqlite` every other suite runs on.

How the fast tier avoids them differs by runner, and the difference is worth knowing before you read a CI log:

| Package | Fast-tier runner | Does `bun run test` load the D1 file? |
|---|---|---|
| `osn/api`, `pulse/api`, `zap/api` | vitest | **No** — the configs `exclude: ["tests/d1/**"]`. Vitest cannot load these files at all: they import `bun:test`. |
| `cire/api` | bare `bun test` | **Yes.** `bun test` discovers recursively and takes no exclude, so the Miniflare suite runs twice per CI run — once inside `@cire/api#test`, once under `test:d1`. Pre-existing and harmless, but it means a workerd failure reddens cire's fast tier too. |

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
bun run --cwd osn/auth-ui test:run
bun run --cwd shared/ui test:run          # unit project only
bun run --cwd pulse/db test:run
bun run --cwd zap/api test:run
bun run --cwd zap/db test:run

# Watch mode
bun run --cwd pulse/api test

# The browser tier, per package
bun run --cwd shared/ui test:browser
```

`@shared/ui` runs the two-project split — `unit` and `browser` — that
`@cire/host`, `@musubi/social` and `@pulse/web` also run, so its `test` and
`test:run` scripts name `--project unit` and the Chromium tier is the separate
`test:browser` script. `@osn/auth-ui` has one plain config and therefore no
`test:browser` to run.

## Related

- [[backend-patterns]] -- service and route layer architecture
- [[schema-layers]] -- Elysia TypeBox vs Effect Schema
- [[commands]] -- full CLI reference
