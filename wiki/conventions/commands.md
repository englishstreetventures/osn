---
title: CLI Commands Reference
description: Full reference for all CLI commands used in the OSN monorepo
tags: [convention, reference]
related:
  - "[[contributing]]"
  - "[[testing-patterns]]"
last-reviewed: 2026-04-23
---

# CLI Commands Reference

## Development

```bash
bun run dev              # Start all dev servers (turbo)
bun run build            # Build all packages (turbo)
bun run check            # Type-check all packages (turbo)
```

## Testing

```bash
bun run test                              # Run all tests (turbo, skips packages without test script)

# Package-specific (run once)
bun run --cwd pulse/api test:run          # Pulse API tests
bun run --cwd osn/api test:run            # OSN API (auth + graph + orgs) tests
bun run --cwd osn/client test:run         # OSN Client SDK tests
bun run --cwd osn/ui test:run             # Shared UI component tests
bun run --cwd pulse/db test:run           # Pulse DB schema tests

# Watch mode
bun run --cwd pulse/api test              # Pulse API tests in watch mode
```

Always use `bunx --bun vitest` instead of plain `vitest` -- the `--bun` flag is required for `bun:sqlite` module access. The `test:run` scripts in each `package.json` already include this flag.

## Code Quality

```bash
bun run lint             # Run oxlint across the monorepo
bun run fmt              # Format code with oxfmt
bun run fmt:check        # Check formatting (used in CI)
```

Pre-commit hooks (via lefthook) automatically run oxlint + oxfmt on staged files. Pre-push hooks run the type checker.

## Database

Run these from the relevant package directory:

```bash
bun run db:migrate       # Generate Drizzle migrations
bun run db:push          # Push schema changes to the database
bun run db:studio        # Open Drizzle Studio (visual DB browser)

# Example: open Drizzle Studio for Pulse DB
bun run --cwd pulse/db db:studio
```

## Versioning

```bash
bun run changeset        # Create a new changeset (required for every PR)
```

**Important notes:**

- Every PR must include a changeset -- CI will fail without one
- Changeset packages must use the workspace `name` field exactly (e.g. `"@pulse/app"`, not `"pulse"`)
- `bun run version` runs automatically on merge to main -- do not run manually
- The Changeset Check workflow runs `bunx changeset status` to catch typos before merge

## Maintenance

```bash
bun run clean            # git clean -fdX (remove ignored files)
bun run reset            # clean + reinstall all dependencies
```

## Tauri

Run from the app directory (e.g. `pulse/app/`):

```bash
bunx tauri init          # Initialize a new Tauri app
bunx tauri dev           # Start Tauri dev server
bunx tauri build         # Build Tauri app for distribution
```

Tauri apps are created via CLI (`bunx create-tauri-app`), not manually.

## Workspace Installs

Use `--cwd` (not `--filter`) for workspace-scoped installs:

```bash
bun add solid-js --cwd osn/landing
bun add drizzle-orm --cwd pulse/db
bun add <package> --cwd <workspace-path>
```

## Related

- [[contributing]] -- PR workflow and conventions
- [[testing-patterns]] -- test patterns and examples
