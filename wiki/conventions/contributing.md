---
title: Contributing
description: PR workflow, conventions, and development practices for the OSN monorepo
tags: [convention, workflow]
related:
  - "[[commands]]"
  - "[[review-findings]]"
  - "[[stacked-prs]]"
  - "[[testing-patterns]]"
last-reviewed: 2026-11-15
---

# Contributing

## Development Conventions

### Technology Choices

- **Effect.ts** is the backend, settled: every API, the shared packages and `@osn/client` are built on it. Keep `effect` and the `@effect/*` packages on the same exact version so a dependency refresh cannot resolve mixed Effect releases. The frontends do not use it — see [[frontend-patterns]]
- **E2E encryption everywhere**: encrypt all user-to-user communication end-to-end
- **Personalisation data**: show it to the user, and let the user reset it

### Messaging Architecture

The messaging backend (`@zap/api`) is a **shared service**:
- Zap consumes it directly as the messaging client
- Pulse uses it indirectly for event group chats
- Users do not need a Zap install to join event group chats

### Platform Priority

**iOS > Web > Android**

Android is deferred. iOS is the primary native target (Swift). Web support follows from the SolidJS frontend.

## Code Quality

### Pre-commit (lefthook)

Lefthook runs automatically on every commit:
- **oxlint** -- lints staged files
- **bun fmt** -- formats staged files
- **Secret scan** -- `scripts/secret-scan.sh staged`, advisory. CI scans the same commits and blocks the merge.
  The hook prints one line and passes when gitleaks 8.30.1 or later is not installed (`brew install gitleaks`).
  `--no-verify` skips it; the policy file it reads is `origin/main`'s `.gitleaks.toml`, so a local edit to that file does not change what it allows.
  Known limit: a release commit pushed with `--no-verify` skips it; CI scans that commit after the push.

### Pre-push (lefthook)

Lefthook runs on push:
- **Type check** -- full `tsc` across the monorepo

### Linting

oxlint is configured via `oxlintrc.json` at the repo root. The React plugin is **disabled** because the codebase uses SolidJS, not React.

### Runtime

Always use the `bunx --bun` flag for tooling. This bypasses Node.js and runs directly in Bun.

## Git Workflow

### Branch Strategy

- **PRs are required** to merge to main -- no direct pushes
- **Always work on a feature branch** -- never commit directly to main
- Create descriptive branch names (e.g. `feat/event-rsvp`, `fix/auth-otp-expiry`)
- **One goal split across several PRs** -- stack them: each branch cut from the one below it, each PR based on its parent. GitHub infers neither half -- the base is set with the gh CLI at creation time, and the stack is registered with `gh stack link`. See [[stacked-prs]]

### Changesets

Every PR that touches a versioned package **must** include a changeset (the exceptions are below):

```bash
bun run changeset
```

**Critical:** Changeset packages must use the **workspace `name` field exactly** as it appears in `package.json`. For example:

| Correct | Wrong |
|---------|-------|
| `"@pulse/web"` | `"pulse"` |
| `"@osn/api"` | `"osn-api"` |
| `"@shared/db-utils"` | `"db-utils"` |

The Changeset Check workflow runs `bunx changeset status` to catch typos before merge. A bad package reference passes the check but fails the Release workflow on main, and blocks all later versioning.

Never mix version-less packages (`@cire/*`) and versioned ones in one changeset — split them. `scripts/validate-changesets.sh` enforces both rules.

**When none is needed.** A pull request that touches nothing a versioned package ships — `shared/swift/`, `pulse/ios/`, `osn/ios/`, `.github/`, `.claude/`, `scripts/`, `wiki/`, `docs/`, top-level prose — needs no changeset, because there is no honest package to name. The test is an allowlist, `scripts/changeset-required.sh` (fixtures in `scripts/tests/changeset-required.test.sh`); anything not on it, `bun.lock` and root `turbo.json`/`tsconfig.json` included, still requires one. Always pipe the diff in:

```bash
git diff --name-only origin/main...HEAD | bash scripts/changeset-required.sh
```

A bare run at a terminal refuses, but a bare run from a non-interactive shell (as from an agent) cannot tell closed stdin from an empty diff, so it is no substitute.

`.changeset/config.json` must keep `"privatePackages": { "version": true, "tag": false }`. Every workspace package is `private: true`, and `@changesets/config` 4 defaults that `version` to `false`: drop the line and `changeset add` aborts with "No versionable packages found".

### Dependencies

- **Never a bare `bun install`.** Resolving on one machine drops every lockfile entry for a platform it is not running on — on a Mac, all the non-darwin binaries CI needs. Install with `bun install --frozen-lockfile`; when a dependency changes, splice its `bun.lock` entry by hand and prove it with `bun install --frozen-lockfile`.
- **Add with `--cwd`, not `--filter`:** `bun add drizzle-orm --cwd pulse/db`.
- **Vitest pins.** `vitest` and every `@vitest/*` package are pinned exactly, all to the same version, in every workspace that declares them: `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-istanbul` and `@vitest/ui` each name that exact `vitest` version as a peer, so a caret range that resolves a newer `vitest` breaks them.
- **Playwright pins.** `playwright` (every workspace with a browser tier) and `tools/e2e`'s `@playwright/test` are pinned exactly, all to the same version. Each version wants its own Chromium build, and the browser-test and E2E jobs in CI share one browser cache key, so two versions would leave one job downloading its build on every run ([[browser-tests#CI]]). `bun run check:playwright-pins` (also in CI) fails on a Playwright or Vitest pin that is not exact or differs from the rest.
- **Release-age soak.** `bunfig.toml` sets `minimumReleaseAge = 259200` (3 days), so a fresh publish cannot install at once. Each entry in `minimumReleaseAgeExcludes` must carry a `# DROP AFTER <name> <YYYY-MM-DD>` comment dated no more than 30 days out; `bun run check:release-age-excludes` (also in CI) fails on a missing, invalid, expired or over-long marker, and on the soak dropping below 259200. Bun reads `bunfig.toml` from the current directory only, so a `bunx` run from a package directory gets no soak: pass `--minimum-release-age 259200` in any `bunx` command a page documents.
- **A root dependency redeploys everything.** `scripts/deploy-surfaces.ts` counts root `package.json` and `bun.lock` as content every surface builds from, so adding a root dev dependency redeploys every dev surface and puts every surface into the next production release. A tool that has nothing to check yet waits for a branch that changes the lockfile anyway; [[i18n]] is the worked case.
- **Advisory audit.** Pre-push runs `bun audit --audit-level=high`, so a high or critical advisory in any installed package refuses the push. Fix it with an override in the root `package.json` or an upstream bump that has cleared the soak. An `--ignore` entry is possible only when no fixed version exists, the advisory is not a malicious-package advisory, no deployed build contains the package, and no attacker-controlled input reaches the flawed code wherever the package does run; it needs the owner's approval on its pull request. The comment above `audit` in [`lefthook.yml`](../../lefthook.yml) holds the full rule, the live list, and each entry's reason and drop-trigger. Write the full `GHSA-xxxx-xxxx-xxxx` id: bun matches `--ignore` against any part of the advisory URL, so `--ignore=GHSA-` silences every advisory. Each entry also carries a `# DROP AFTER <GHSA id> <YYYY-MM-DD>` marker dated no more than 90 days out; `scripts/check-audit-ignores.ts`, run by the `audit-ignores` pre-push command and in CI, fails on a missing, invalid, expired or over-long marker. It also holds the command to one form — `bun audit --audit-level=high` followed only by `--ignore=<GHSA id>` flags — lets the `audit` entry carry only `run:` and the `pre-push` hook only `parallel:` and `commands:`, and fails on a top-level `extends`, `remotes`, `rc` or `templates`. CI checks the file only; `bun audit` itself runs only in the local hook. When a marker expires, repeat the reachability check: if it holds, move the date; if not, remove the flag. Keep those comments above `run:`: inside the folded `run: >` block a `#` line becomes part of the command and the shell drops every flag after it. Never push past the audit with `--no-verify`, which also skips the type check, the release-age check and the audit-ignore check.

### Versioning

Versioning is **automatic**:
- Changesets are consumed and committed by CI on merge to main
- Do **not** run `bun run version` manually

## PR Checklist

Before opening a PR, verify:

- [ ] Feature branch (not main)
- [ ] Base branch correct -- `main`, or the parent branch if this PR is stacked, and the stack registered with `gh stack link` ([[stacked-prs]])
- [ ] Changeset included, or the diff genuinely needs none -- `git diff --name-only origin/main...HEAD | ./scripts/changeset-required.sh` answers `required` or `skip`
- [ ] Changeset valid (`./scripts/validate-changesets.sh`) -- package names match workspace `name` fields, and no changeset mixes ignored with versioned packages
- [ ] Lockfile honest (`bun install --frozen-lockfile`) -- if `bun.lock` is in the diff, this must pass without rewriting it. An install on one machine prunes entries for every platform it is not running on; splice the entry by hand rather than committing that
- [ ] Vitest DOM markers intact (`bun run check:jest-dom-markers`) -- every `vitest.config.ts` using `vite-plugin-solid` still names a `jest-dom` path in `setupFiles`
- [ ] Tests pass (`bun run --cwd <package> test:run`, or `test` where the package's `test` script is `bun test` or it has no `test:run`)
- [ ] Linting passes (`bun run lint`)
- [ ] Formatting passes (`bun run fmt:check`)
- [ ] Type check passes (`bun run typecheck`)
- [ ] Opened as a draft if it waits on the owner -- a decision about the change still open, an approval only the owner can give, or a "not ready" only they can settle. Its `**Do not merge until**` line says which, it still runs CI, and only the owner marks it ready (the `prep-pr` skill, Step 9). A CODEOWNERS path or a default the session took does not make it one

## What CI runs for a change

The `main` ruleset requires four checks: `CI` (the gate job in `.github/workflows/ci.yml`, which needs every job there but `E2E`), `Require changeset`, `Migration history` and `Secret scan`. The merge queue runs the same four.

**A prose-only change skips the heavy jobs.** The first job in `ci.yml`, `Detect a prose-only change`, diffs the change and pipes the paths through [`docs-only.sh`](../../scripts/docs-only.sh). When every path is prose, Type Check, Build & Test, the `@cire/api` unit tests, the D1 tests, the three browser legs, OpenAPI Freshness, the migration workflow and `E2E` are skipped, and the `CI` gate counts a skipped job as passed. Lint & Format, Scripts and the Secret scan run on every change. Prose is:

| Counts | Does not count |
|---|---|
| anything under `wiki/` or `docs/`; a changeset; any other `*.md` | `AGENTS.md`, `CLAUDE.md`; any `*.md` under `.claude/`, `.agents/`, `.github/`, `scripts/` or `tools/` (the script tests read the skills and agent definitions); any `*.md` under a `src/` or `tests/` directory; every other file |

A pull request diffs its merge commit against the base it was merged with; a merge-queue group diffs against the queue's base, so a prose entry queued behind one with code runs every job; a push to `main` diffs against the commit it replaced. The diff names both sides of a rename (`--no-renames`), so code moved under `wiki/` still counts as code, and the classifier is the base's copy of `docs-only.sh`, so a change that edits it is judged by the rules it lands on. A diff that cannot be computed, or a base with no classifier, runs every job. A rule never goes on a required workflow's `on: paths`: a workflow that does not start leaves its required check waiting, and the pull request cannot merge.

`scripts/tests/deploy-workflows.test.ts` holds which jobs may skip and runs the detection step against throwaway repositories, one per event; `scripts/tests/docs-only.cli.test.ts` holds what counts as prose.

`E2E` runs the suite once and reruns a failed run whole; `E2E determinism` runs it twice and compares, daily and by hand only, so no pull request or push runs the suite twice ([[testing-patterns#The end-to-end suite]]). Swift CI (`ci-swift.yml`) runs only when Swift, Xcode or the OpenAPI documents change.

*Measured 2026-11-11 — job times from `gh api repos/englishstreetventures/osn/actions/runs/<id>/jobs` on seven pull-request runs: a wiki-only change (run 42205244609) spent 9 min 9 s in `E2E`, 2 min 17 s in the migration workflow and 30 to 47 s in each other job; the gate's slowest need on most changes is the migration workflow, at 1.5 to 2.4 min.*

## Observability Checklist

Every feature PR should also answer:

- [ ] **Logs** -- are all error paths covered by `Effect.logError`? Any `console.*` calls? Any new secret fields for the redaction deny-list?
- [ ] **Traces** -- is every service function wrapped in `Effect.withSpan`? Span names consistent, under 64 bytes, attributes free of PII?
- [ ] **Metrics** -- new counters/histograms needed? Added to correct `metrics.ts`? Typed `Attrs`? Cardinality bounded?

## Related

- [[commands]] -- full CLI reference
- [[review-findings]] -- finding ID system for PR reviews
- [[stacked-prs]] -- opening a PR on top of another PR
- [[testing-patterns]] -- test conventions and examples
