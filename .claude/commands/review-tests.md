Build the affected workspaces and analyse the test surface to ensure the feature is appropriately and extensively tested. $ARGUMENTS should contain a list of affected workspace paths (e.g. `packages/api apps/pulse`); if not provided, derive them from `git diff --name-only main...HEAD`.

---

## Step 1 — Build affected workspaces

For each affected workspace, run in parallel using the Agent tool:

```
bun run build --filter=@osn/<name>
```

Turbo will resolve dependency order. Report pass/fail for each. If any build fails, show the error and stop — do not proceed until builds pass.

---

## Step 2 — Run tests for affected workspaces

For each affected workspace that has a `test:run` script, run in parallel:

```
bun run --cwd <workspace-path> test:run
```

Use `bunx --bun vitest run` if no `test:run` script exists but a `vitest.config.ts` is present.

Report pass/fail and test counts for each workspace. If any tests fail, show the failing test names and output, and stop.

---

## Step 3 — Analyse test coverage of changed code

Read all changed source files (`git diff main...HEAD -- <workspace-path>/src`) and cross-reference them against the test files in `<workspace-path>/tests/` (mirroring `src/` structure per project conventions).

For each changed source module, check:

- **Is there a corresponding test file?** If a new `src/services/foo.ts` was added but no `tests/services/foo.test.ts` exists, flag it.
- **Are the new exported functions/effects tested?** Scan the test file for calls to the new functions. Flag any exported function that has no test coverage.
- **Are error paths tested?** For Effect.ts services, check that `EventNotFound`-style tagged errors are asserted with `Effect.flip` (per project testing patterns). Flag missing negative-path tests.
- **Are route handlers tested?** For new Elysia routes, check for corresponding HTTP integration tests using the `createXxxRoutes(createTestLayer())` pattern.
- **Are edge cases covered?** Look for boundary inputs (empty arrays, max lengths, invalid IDs) being tested.

---

## Step 4 — Report

Produce a structured report:

### Build
- List each workspace and build status (✓ / ✗)

### Tests
- List each workspace, test counts, and pass/fail status

### Coverage gaps
Prioritised list:
- **Missing** — no test file exists for a changed module
- **Untested export** — a new/changed function has no test assertions
- **Missing error path** — Effect error cases not tested
- **Missing integration test** — new route with no HTTP test
- **Suggestion** — additional edge cases worth adding

If test coverage is thorough and all tests pass, state: "Build and test surface look good."
