Build the project and analyse test coverage to ensure the change is appropriately tested. $ARGUMENTS may contain a list of affected workspace paths; if not provided, derive from `git diff --name-only main...HEAD`.

---

## Step 1 — Build

For each affected workspace, run in parallel:
- `bun --cwd apps/web run build` (if apps/web is affected)
- `bun --cwd apps/api run build` (if apps/api is affected)
- `bun --cwd packages/db run build` (if packages/db is affected)

Report pass/fail. Stop if any build fails.

---

## Step 2 — Run tests

For each affected workspace with tests, run in parallel:
- `bunx --bun vitest run --root apps/web` (if apps/web is affected)
- `bunx --bun vitest run --root apps/api` (if apps/api is affected)

Report pass/fail and test counts. Stop if any tests fail.

---

## Step 3 — Analyse coverage of changed code

Read all changed source files (`git diff main...HEAD -- <path>/src`) and cross-reference against test files.

For each changed module, check:
- **Is there a corresponding test file?** (Flag if missing — `*.test.ts` co-located with source)
- **Are new exported functions tested?** (Flag any untested exports)
- **Are error/failure paths tested?** (e.g. invalid claim code, expired magic link token, unauthenticated request)
- **Are edge cases covered?** (Boundary inputs, empty collections, invalid IDs)
- **Are new Hono route handlers tested?** (Flag any route without an integration test using `app.request()`)
- **Are new Drizzle schema changes covered?** (Flag if migration exists but no test exercises the new columns/tables)
- **Observability check** — are new service functions instrumented (error logging on failure paths)?
- **Wiki check** — if architecture changed, is wiki updated?

---

## Step 4 — Report

### Build
- List each workspace and build status (✓ / ✗)

### Tests
- List each workspace, test counts, pass/fail

### Coverage gaps
- **Missing** — no test file for changed module
- **Untested export** — new/changed function with no test assertions
- **Missing error path** — failure cases not tested
- **Missing route test** — new Hono route with no HTTP integration test
- **Suggestion** — additional edge cases worth adding

If coverage looks thorough and all tests pass, state: "Build and test surface look good."
