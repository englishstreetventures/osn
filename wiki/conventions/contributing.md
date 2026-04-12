---
title: Contributing
description: PR workflow, conventions, and development practices for the OSN monorepo
tags: [convention, workflow]
---

# Contributing

## Development Conventions

### App Scaffolding

- **Tauri apps** are created via CLI (`bunx create-tauri-app`), not manually
- Follow the existing Pulse app structure for new Tauri apps

### Technology Choices

- **Effect.ts**: trial with OSN/Pulse first, then decide on broader adoption (see Deferred Decisions in TODO.md)
- **E2E encryption everywhere**: all user-to-user communication must be encrypted end-to-end
- **All personalization data must be user-accessible and resettable**

### Messaging Architecture

The messaging backend (`@zap/api`) is a **shared service**:
- Zap consumes it directly as the messaging client
- Pulse uses it indirectly for event group chats
- Users do not need a Zap install to participate in event group chats

### Platform Priority

**iOS > Web > Android**

Android is deferred. iOS is the primary target for Tauri apps. Web support comes naturally from the SolidJS frontend.

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

### Changesets

Every PR **must** include a changeset:

```bash
bun run changeset
```

**Critical:** Changeset packages must use the **workspace `name` field exactly** as it appears in `package.json`. For example:

| Correct | Wrong |
|---------|-------|
| `"@pulse/app"` | `"pulse"` |
| `"@osn/core"` | `"osn-core"` |
| `"@shared/db-utils"` | `"db-utils"` |

The Changeset Check workflow runs `bunx changeset status` to catch typos before merge. A bad package reference will pass the check but fail the Release workflow on main, blocking all subsequent versioning.

### Versioning

Versioning is **automatic**:
- Changesets are consumed and committed by CI on merge to main
- Do **not** run `bun run version` manually

## PR Checklist

Before opening a PR, verify:

- [ ] Feature branch (not main)
- [ ] Changeset included (`bun run changeset`)
- [ ] Changeset package names match workspace `name` fields
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
- [[testing-patterns]] -- test conventions and examples
