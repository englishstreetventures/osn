---
name: review-tests
description: Use when checking whether a branch is adequately tested — building and running the affected workspaces, then auditing changed code for missing test files, untested exports, untested error paths and untested routes — and reporting gaps with T-M/U/E/R/S IDs in the four-field format.
---

Build the affected workspaces, run their tests, and audit what the branch changed against what the branch tests.

`$ARGUMENTS` may name the affected workspace paths. Whether or not it does, start from the diff.

## Step 0 — Write the report skeleton before you audit anything

Do this before the diff, before building anything. The file is the deliverable:
a run that leaves a differently-shaped file has produced nothing, however good
the audit inside it. Writing the shape now means the rest of the run only fills
it in — and it survives a toolchain that turns out to be broken, which is the
case this report most often has to describe.

Copy this verbatim. The report file is `TEST-REVIEW.md` unless the task named
another:

```bash
cat > TEST-REVIEW.md <<'EOF'
## Build

None

## Tests

None

## Coverage gaps

None

## Files audited

None

## Not run

None
EOF
```

Those five `##` headings are the whole permitted set, and that is their order.
Replace a `None` as you fill its section in; leave it where the section really
is empty. `## Not run` keeps that name even when what it records is the whole
toolchain — `## Statement of limitations` is not it. Never add a sixth `##`:
`## Summary`, `## Verdict`, `## Scope and method` and `## Bottom line` are the
ones that get invented, and none is allowed. A summary sentence goes at the top
of `## Coverage gaps`; anything the toolchain stopped you doing goes in
`## Not run`.

**From here on this file is only ever edited, never rewritten.** Every later
change replaces a `None`, or inserts text under a heading that already exists.
Do not compose the report in your head and write it out whole at the end — a
single write to `TEST-REVIEW.md` discards the shape this step just established,
and that is the one way this run fails outright however good the audit is. If
you find yourself about to write the whole file, you have lost the skeleton:
read it back first and edit what is there.

**A gap is a bold label, not a heading.** `T-U1` goes on its own line as bold
text inside `## Coverage gaps`, exactly as **Finding format** shows below.
Promoting it to `## T-U1` adds a top-level section, and a run whose gaps each
became a heading fails the shape check with five correct sections still sitting
in the file. The same goes for `## Summary`, `## Verdict` and anything else the
audit suggests along the way.

Every gap carries a `T-` ID in the four-field format. What each section holds is
under **Report shape** at the end of this file.

## When a step cannot run

**No step is a stop.** A failing build, a failing test, a missing package manager, no network — each of those is a result to record, not a reason to abandon the run. Steps 3 and 4 read source and tests from disk and do not need a working toolchain, so they run regardless. Record what did not run, and why, under `## Not run`.

## Step 1 — Resolve the base and the workspaces

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
git diff --name-only "$BASE"...HEAD
```

A stacked branch does not merge into `main`; taking the base from `gh-merge-base` keeps the parent branch's files out of this branch's diff.

The affected workspaces are the packages owning those files. Map a path to its package by walking up to the nearest `package.json` and reading its `name`.

## Step 2 — Build and test each workspace

Build:

```bash
bun run --cwd <workspace-path> build
```

Then tests, for each workspace whose `package.json` has a `test:run` script:

```bash
bun run --cwd <workspace-path> test:run
```

If there is no `test:run` but a `vitest.config.ts` is present, use `bunx --bun vitest run`. If neither exists, the package has no test surface — record that; it is itself a finding if the branch added source to it.

Record for each workspace: build pass or fail, test counts, pass or fail. Quote the shortest decisive line of any failure — a failing assertion, not the whole log.

A failure does not end the run. A test that fails on this branch is the most important thing in the report; carry it into `## Tests` and keep going.

## Step 3 — Find the tests for the changed code

Tests live in `tests/` at the package root, mirroring `src/` — every package, `cire/*` included. `src/services/foo.ts` pairs with `tests/services/foo.test.ts`. Test-only support code (mocks, request harnesses, fixtures) lives under `tests/` too, so `src/` holds nothing test-shaped. `scripts/` is not a workspace but follows the same rule, shell tests included. The one carve-out is the Miniflare-backed D1 lane at `tests/d1/` (cire's at `tests/db/`), which only `bun run test:d1` runs.

**Resolve where a package's tests actually are from what is on disk, never from the convention alone.** The convention became universal on 2026-09-01; before that `cire/*`, the three landing sites and `scripts/` all kept tests beside their source, so a branch cut before the move, a vendored tree, or a long-lived branch that has not rebased will still be co-located. Run this first, and let it — not this page — decide what pairs with what:

```bash
ls <workspace-path>/tests 2>/dev/null; find <workspace-path>/src -name '*.test.ts*' | head
```

A changed source file with no test file in **either** location is `T-M`. A test file the branch **adds** under `src/` is `T-S` — it is in the wrong place under the current convention and the runner may not even collect it. Tests already sitting beside their source in a checkout that predates the move are not a finding, and proposing to relocate them is out of scope for a review of this branch; say so on the line rather than reporting it.

## Step 4 — Audit each changed source file

For each changed source file, open it and its test file together and check:

- **Every new or changed export is called by a test.** Grep the test file for the identifier. An export nobody calls is `T-U`. Do not count a test that imports a module and never touches the function.
- **Error paths are asserted.** For Effect services, a tagged error (`EventNotFound`-style) is asserted with `Effect.flip`. A happy-path-only test of a function with failure modes is `T-E`. See `wiki/conventions/testing-patterns.md`.
- **New routes have HTTP tests.** An Elysia route needs an integration test through `createXxxRoutes(createTestLayer())` — status codes, and the authorisation gate as well as the success. A route tested only through its service layer is `T-R`.
- **Both sides of a gate are tested.** A middleware, role gate or entitlement check needs a test that it *denies*, not only that it permits. A permit-only test is `T-E`.
- **Every handler in the diff: enumerate what it accepts as a caller, then check the tests present each one.** Do this as a step, not as a glance, because the thing that goes untested is a *branch* of an auth path rather than a whole function, and nothing in the diff looks missing.

  1. For each changed route or handler, find what authenticates it — a `resolveCaller`, a `requireAuth`, a middleware, a session lookup. **Open that resolver even when it is not in the diff.** It usually is not: a branch adds routes and reuses the resolver the repo already had. Its being on the base branch does not put it out of scope, because what is under audit is not the resolver — it is whether *this branch's tests* exercise the ways in it.
  2. List every credential it accepts. A resolver that takes `Authorization: Bearer …` **or** a session cookie accepts two, and they are two separate paths through the handler.
  3. For each, grep the branch's test file for a case that presents it. A credential no test presents is `T-E`, and it is the same finding whether the resolver is new or not.
  4. For each, grep for a case that presents it *wrongly* — absent, malformed, expired, or naming no live session. Missing is `T-E` too, and this is the half that matters most: **a positive-only test cannot tell a working credential lookup from a handler that authenticates nobody**, because both make the request succeed. Say that sentence in the `Why`; it is the argument the finding rests on.

  Name the specific cases in the `Solution` — not "add cookie tests" but "one case presenting a valid session cookie, and one presenting a cookie that names no live session, asserting 401". Do not accept "covered by the resolver's own suite" as an answer: the resolver's tests prove the resolver works, not that the route reaches it.
- **Boundaries are covered.** Empty arrays, maximum lengths, invalid IDs, a cap at exactly its limit and one over. Missing boundaries are `T-S`.
- **A test that needs real CSS or layout is in the right project.** Computed classes, layout, and anything reading geometry belong to the Chromium Vitest project, not jsdom — `wiki/conventions/browser-tests.md`. A layout assertion in a jsdom test is `T-S`, and usually a test that cannot fail.

**Check the shape once, as soon as the first gap is in the file.** Not at the
end — by then a clobbered skeleton has cost the whole run:

```bash
grep -c '^## \(Build\|Tests\|Coverage gaps\|Files audited\|Not run\)$' TEST-REVIEW.md
```

It must print `5`. If it prints less, the skeleton from Step 0 was overwritten
rather than edited: restore the five headings, put the gap back under
`## Coverage gaps`, and edit from then on.

A test asserting only that a function returns without throwing is not coverage. Say so, as `T-U`, and name what it should assert.

**A comment is a claim, not a test.** A `// covered by the integration suite`, a
describe block named after a case it never asserts, or a doc comment listing
error modes is not evidence any of it runs. Grep for the assertion. Coverage is
what an assertion would go red over, nothing else.

## Finding format

IDs: `T-M1`, … missing test file; `T-U1`, … untested export; `T-E1`, … untested error path; `T-R1`, … untested route; `T-S1`, … suggestion. The counter increments within each tier across the whole report.

Each gap uses exactly this structure:

```
**T-U1** — <short title>
**Issue:** What is untested, with the file and the export name.
**Why:** The failure mode this leaves undetected — what could break in production and no test would go red.
**Solution:** The test to add, named after the pattern it should follow.
**Rationale:** Why that test closes the gap.
```

Tiers:

- **Missing (T-M)** — a changed module with no test file in either layout.
- **Untested export (T-U)** — a new or changed export no test exercises.
- **Error path (T-E)** — failure and denial cases unasserted.
- **Route test (T-R)** — a new route with no HTTP integration test.
- **Suggestion (T-S)** — edge cases and test-placement improvements worth adding.

## Report shape

The file already exists — Step 0 wrote it, with the five sections in order.
Keep that. This section says what goes in each one.

`## Coverage gaps` holds the gaps, in the four-field format above.

`## Build` and `## Tests` list every affected workspace with its status, and test counts where they ran.

`## Files audited` lists **every changed source file** from the Step 1 diff, one line each, with the test file it pairs with and a verdict — a gap ID, or `covered`, or `not source` (lockfiles, generated output, fixtures, migrations). A file you did not open is not covered; say you did not open it and why.

`## Not run` lists every gate that could not run and the reason. An empty section is the good case; an absent section reads as a claim that everything ran.

### Check the file before you finish

Run these two counts on the file you just wrote:

```bash
grep -c '^## \(Build\|Tests\|Coverage gaps\|Files audited\|Not run\)$' <report-file>
grep -c '^## ' <report-file>
```

Both must print `5`. A first count under 5 means a section was renamed,
demoted to `###`, or overwritten while you were filling it in. A second count above 5 means you added a top-level section
of your own — the usual ones are `## Summary`, `## Verdict`, `## Scope and
method` and `## Bottom line`. None of those is allowed as a `##`. A summary
sentence goes at the top of `## Coverage gaps`; anything the toolchain stopped
you doing goes in `## Not run`.

If the build and tests pass and the audit finds no gaps, say "Build and test surface look good." — and still fill in `## Files audited`.
