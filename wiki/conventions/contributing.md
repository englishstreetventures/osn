---
title: Contributing
description: PR workflow, conventions, and development practices for the OSN monorepo
tags: [convention, workflow]
related:
  - "[[commands]]"
  - "[[review-findings]]"
  - "[[stacked-prs]]"
  - "[[testing-patterns]]"
last-reviewed: 2026-08-31
---

# Contributing

## Development Conventions

### Technology Choices

- **Effect.ts**: trial with OSN/Pulse first, then decide on broader adoption (an open decision issue in `xchromo/osn`)
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
- **oxfmt** -- formats staged files

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

Every PR **must** include a changeset:

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
- [ ] Tests pass (`bun run --cwd <package> test:run`)
- [ ] Linting passes (`bun run lint`)
- [ ] Formatting passes (`bun run fmt:check`)
- [ ] Type check passes (`bun run check`)

## Observability Checklist

Every feature PR should also answer:

- [ ] **Logs** -- are all error paths covered by `Effect.logError`? Any `console.*` calls? Any new secret fields for the redaction deny-list?
- [ ] **Traces** -- is every service function wrapped in `Effect.withSpan`? Span names consistent? Outbound HTTP through `instrumentedFetch`?
- [ ] **Metrics** -- new counters/histograms needed? Added to correct `metrics.ts`? Typed `Attrs`? Cardinality bounded?

## Related

- [[commands]] -- full CLI reference
- [[review-findings]] -- finding ID system for PR reviews
- [[stacked-prs]] -- opening a PR on top of another PR
- [[testing-patterns]] -- test conventions and examples
