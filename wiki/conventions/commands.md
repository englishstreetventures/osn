---
title: CLI Commands Reference
description: Full reference for all CLI commands used in the OSN monorepo
tags: [convention, reference]
related:
  - "[[contributing]]"
  - "[[testing-patterns]]"
  - "[[devloop-urls]]"
last-reviewed: 2026-10-29
---

# CLI Commands Reference

## Development

```bash
bun run dev              # Start all dev servers (turbo)
bun run build            # Build all packages (turbo)
bun run typecheck        # Type-check all packages (turbo: bun check, or tsc with the .astro mapper in Astro sites)
```

Dev servers answer on named HTTPS hosts, not ports — `https://id.musubi.localhost`, `https://host.cire.localhost` — and each worktree gets its own stack. The names, the one-time `portless proxy start`, and the `PORTLESS=0` fallback are in [[devloop-urls]].

## Testing

```bash
bun run test                              # Run all tests (turbo, skips packages without test script)

# Package-specific (run once)
bun run --cwd pulse/api test:run          # Pulse API tests
bun run --cwd osn/api test:run            # OSN API (auth + graph + orgs) tests
bun run --cwd osn/client test:run         # OSN Client SDK tests
bun run --cwd osn/auth-ui test:run        # OSN auth views (SignIn, Register, StepUpDialog, …)
bun run --cwd shared/ui test:run          # Shared UI primitives — the unit project only
bun run --cwd pulse/db test:run           # Pulse DB schema tests
bun run --cwd cire/api test               # instead of test:run where the test script is `bun test`, or there is no test:run

# Watch mode
bun run --cwd pulse/api test              # Pulse API tests in watch mode

# The real-Chromium tier, per package
bun run --cwd shared/ui test:browser      # Modal, form and data primitives under real CSS

# The end-to-end suite: boots the stack on fixed ports, writes e2e-artifacts/
bun run test:e2e
bun run test:e2e:repro                    # twice; fails unless results.json matches byte for byte
```

The E2E suite refuses to start while anything holds its ports, so stop `bun run dev` first. What it boots and how to read its artifact: [[testing-patterns#The end-to-end suite]].

`@shared/ui` splits its suite into a `unit` project and a `browser` one, so
`test` and `test:run` there cover the unit project alone and `test:browser` is a
separate script. `@osn/auth-ui` has a single config and no `test:browser`.

When you call Vitest yourself, use `bunx --bun vitest` instead of plain `vitest`: the `--bun` flag is required for `bun:sqlite` module access. A package's own `test` and `test:run` scripts already carry the flags its tests need — most of those that run Vitest say `bunx --bun vitest`, and the few whose tests never load `bun:sqlite` call plain `vitest` — so prefer those scripts. The one exception is a mutation run (`test:mutation`, cire only): Stryker starts Vitest under Node itself — [[testing-patterns#Mutation testing]].

## Code Quality

```bash
bun run lint             # Run oxlint across the monorepo
bun run fmt              # Format code with bun fmt
bun run fmt:check        # Check formatting (used in CI)
bun scripts/check-wikilinks.ts  # Every wikilink in wiki/ resolves; exit 1 lists the ones that do not
```

Pre-commit hooks (via lefthook) automatically run oxlint + bun fmt on staged files, and an advisory secret scan (`scripts/secret-scan.sh staged`). Pre-push hooks run the type checker.

## Database

Run these from the relevant package directory:

```bash
bun run db:generate --name <snake_case>  # Write the next migration (osn, pulse, zap, cire)
bun run db:migrate --name <snake_case>   # The same, in osn, pulse and zap
bun run db:push          # Push schema changes to the local database
bun run db:studio        # Open Drizzle Studio (visual DB browser)

# Example: open Drizzle Studio for Pulse DB
bun run --cwd pulse/db db:studio
```

### Migrations

A migration is one file, `<migrations dir>/<YYYYMMDDHHMMSS>_<name>.sql`,
stamped in UTC, with no journal or snapshot beside it, so two pull requests that
each add one never conflict. `db:generate` (`scripts/db-generate.ts`) writes it:
it diffs the working tree's schema against `HEAD`'s, so commit one migration
before generating the next. It never guesses a rename (exit 2, then pass
`--hints`), refuses a copy-and-swap table rebuild, and takes `--custom` for a
hand-written one. Never run `drizzle-kit generate` or `drizzle-kit up` in a db
package: the first writes files wrangler never applies, the second renames
migrations every deployed database has already run.

CI proves the result. The lockstep tests replay each chain against its schema;
`scripts/check-migration-orders.ts` replays a pull request's new files in the
two orders a database can meet them; `scripts/guard-migration-history.ts`
(the `Migration history` check) refuses an edited, renamed, deleted or empty
migration. That check runs `main`'s copy of the guard, so a pull request's own
edits to it apply only once it merges. The merge queue runs the first two on
every group, so two migrations that each pass alone but clash together never
both land. That holds only while the `main` ruleset has the merge queue on
and requires `CI`,
`Require changeset` and `Migration history`; without the queue, each pull
request is checked against `main` alone. A pull
request ejected from the queue for a clash regenerates its migration on top of
the new `main`. The details, written for cire but true of every database:
[[cire-development#Adding a column]] and `cire/db/README.md`.

## Versioning

```bash
bun run changeset        # Create a new changeset (required for every PR)
```

**Important notes:**

- Every PR must include a changeset -- CI will fail without one
- Changeset packages must use the workspace `name` field exactly (e.g. `"@pulse/web"`, not `"pulse"`)
- `bun run version` runs automatically on merge to main -- do not run manually
- The Changeset Check workflow runs `bunx changeset status` to catch typos before merge

## Maintenance

```bash
bun run clean            # git clean -fdX (remove ignored files)
bun run reset            # clean + reinstall all dependencies
```

## Workspace Installs

Use `--cwd` (not `--filter`) for workspace-scoped installs:

```bash
bun add solid-js --cwd musubi/landing
bun add drizzle-orm --cwd pulse/db
bun add <package> --cwd <workspace-path>
```

## Related

- [[contributing]] -- PR workflow and conventions
- [[testing-patterns]] -- test patterns and examples
