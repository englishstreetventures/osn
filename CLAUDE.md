# CLAUDE.md

AI coding assistant reference. For full spec see README.md. For progress/decisions see wiki/TODO.md.

## Quick Context

Cire is a bespoke digital wedding invite — a single Astro + SolidJS site with a Cloudflare Workers backend (Hono + D1 + Drizzle), designed to feel tactile and animated. Currently in early scaffolding phase. Primary apps: `apps/web` (frontend) and `apps/api` (backend), with `packages/db` for shared Drizzle schema.

## File Responsibilities

- `README.md` → Human-readable spec, architecture, stack
- `CLAUDE.md` → AI reference — patterns, conventions, commands
- `wiki/TODO.md` → Progress tracking, backlog, deferred decisions
- `wiki/` → Obsidian knowledge graph — architecture docs, conventions, observability, changelogs, runbooks

## wiki/TODO.md Structure + Maintenance

| Section             | What goes here                           |
| ------------------- | ---------------------------------------- |
| Current Status      | One-paragraph snapshot of what's built   |
| Up Next             | ≤8 highest-priority items                |
| apps/web            | Frontend feature work                    |
| apps/api            | Backend feature work                     |
| packages/db         | Schema and migration work                |
| Security Backlog    | H/M/L security findings                  |
| Performance Backlog | Performance concerns                     |
| Deferred Decisions  | Open questions with options and triggers |
| Future              | Vague post-MVP ideas                     |

Update wiki/TODO.md when: a task is completed, a new concern is discovered, a deferred decision is resolved, or priorities shift.

## Wiki Navigation

| If you need to...               | Read                                          |
| ------------------------------- | --------------------------------------------- |
| Understand monorepo layout      | `[[wiki/architecture/monorepo-structure]]`    |
| Check PR/branch conventions     | `[[wiki/conventions/contributing]]`           |
| Understand observability rules  | `[[wiki/observability/overview]]`             |
| Look up review finding IDs      | `[[wiki/conventions/review-findings]]`        |
| Debug a production issue        | Browse `wiki/runbooks/`                       |
| Check security or perf findings | `wiki/TODO.md` (Security/Performance Backlog) |
| Track progress and priorities   | `wiki/TODO.md`                                |

### Querying the Wiki

With Obsidian: open `wiki/` as a vault, use graph view and search.

Without Obsidian (CLI):

```bash
# Find pages by tag
rg "tags:.*security" wiki/ --glob "*.md"

# Find all pages linking to a topic
rg "\[\[contributing\]\]" wiki/

# List open TODOs
rg "- \[ \]" wiki/TODO.md
```

### Wiki Maintenance Rules

1. **New system = new wiki page** — adding a service, integration, or tool? Create a wiki page for it.
2. **Modify pattern = update wiki page** — changing a convention, flow, or architecture? Update the relevant wiki page.
3. **Frontmatter required** — every wiki page must have `title`, `tags`, `related`, `last-reviewed` in YAML frontmatter.
4. **Use `[[wiki links]]`** — all internal cross-references use Obsidian wiki link syntax.
5. **Update `last-reviewed`** — set to today's date when you modify a wiki page.

## Current State

```
cire/
├── apps/
│   ├── web/          # Pending — Astro + SolidJS (guest-facing)
│   ├── organiser/    # Astro + SolidJS organiser portal (port 4322)
│   └── api/          # Pending — Hono on CF Workers
├── packages/
│   └── db/           # Pending — Drizzle schema + D1 migrations
├── wiki/             # Obsidian knowledge graph
├── README.md         ✓
├── CLAUDE.md         ✓
└── TODO.md           → wiki/TODO.md
```

## Tech (one-liner)

TypeScript, Bun, Cloudflare Workers + Pages, Astro + SolidJS + Motion One, Hono, Effect (backend + DB only), D1 + Drizzle, Passkey + magic link auth, Vitest, oxlint + oxfmt, lefthook, GitHub Actions

## Conventions

- Branch: `main` + `feat/*` branches; merge directly (solo, no PR review required)
- Commits: SSH-signed; descriptive messages
- Hooks: lefthook runs lint + format + tests before every push
- Package manager: `bun` — always use `bun run`, `bunx --bun`, `bun add`
- Monorepo: bun workspaces; scope commands with `--cwd apps/web` or `--cwd apps/api`
- No changesets or versioning scheme — solo project
- Cloudflare bindings (D1, R2, KV) are typed via `wrangler types` — regenerate after schema or binding changes
- **Observability** (see `[[wiki/observability/overview]]` for full guide):
  - No `console.*` in backend — use Effect structured logger (`Effect.logInfo`, `Effect.logWarning`, `Effect.logError`)
  - Log levels: debug (local only), info (happy path), warning (recoverable), error (unrecoverable)
  - Never log PII (email, tokens, passwords, passphrase values)
  - Redaction deny-list: `password`, `passphrase`, `token`, `email`, `sessionId`, `passwordHash`
  - Always log error paths — every `catch` / `Effect.catchAll` must emit a log line

## Testing Patterns

```typescript
// Vitest — unit test (service layer)
import { describe, it, expect } from "vitest";
import { generateClaimCode } from "../services/claims";

describe("generateClaimCode", () => {
  it("produces an unguessable code matching expected format", () => {
    const code = generateClaimCode();
    expect(code).toMatch(/^[A-Z]+-[A-Z0-9]{4}$/);
  });
});
```

```typescript
// Vitest — Hono route integration test
import { describe, it, expect } from "vitest";
import { app } from "../index";

describe("POST /claim", () => {
  it("returns 401 for an unknown claim code", async () => {
    const res = await app.request("/claim", {
      method: "POST",
      body: JSON.stringify({ code: "FAKE-0000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
```

- Test files live alongside source: `*.test.ts` co-located with the module
- Run tests: `bun run test` (all workspaces) or `bun --cwd apps/api run test`
- Integration tests use a local D1 instance via `wrangler dev` — do not mock the database

## Key Patterns

### Backend (Hono on CF Workers + Effect)

- Routes in `apps/api/src/routes/` — one file per domain (guests, rsvp, auth, events, claims)
- Middleware (auth guard, passkey validation) in `apps/api/src/middleware/`
- Business logic in `apps/api/src/services/` — routes delegate to services, no logic in handlers
- Services return `Effect.Effect<A, E>` — use `Effect.runPromise` / `Effect.runSync` in route handlers to unwrap
- Error types are tagged classes extending `Data.TaggedError` — no thrown exceptions in service layer
- D1 access via Drizzle only — no raw SQL string construction
- Cloudflare env bindings typed from `wrangler types` output (`worker-configuration.d.ts`)
- Effect is backend + DB only — never import it in `apps/web`

### Frontend (Astro + SolidJS)

- Astro pages in `apps/web/src/pages/` — `.astro` files for static shells
- SolidJS islands for interactive components — `client:load` or `client:visible` as appropriate
- Page-level transitions: Astro View Transitions API
- Component-level animations: `@motionone/solid`
- Keep animation logic in `*.motion.ts` files co-located with components

## Commands

```bash
# Dev
bun run dev                          # Start all apps
bun --cwd apps/web run dev           # Web only
bun --cwd apps/api run dev           # API only (wrangler dev)

# Build
bun run build                        # Build all workspaces
bun --cwd apps/web run build
bun --cwd apps/api run build

# Test
bun run test                         # All workspaces
bun --cwd apps/api run test
bun --cwd apps/web run test

# Lint + Format
bunx oxlint .
bunx oxfmt .
bunx oxfmt --check .                 # CI check

# Database
bunx wrangler d1 migrations apply cire-db --local   # Local migrations
bunx wrangler d1 migrations apply cire-db            # Production
bunx wrangler types                                   # Regenerate CF binding types

# Deploy
bunx wrangler deploy                                  # Deploy API worker
bun --cwd apps/web run build && bunx wrangler pages deploy apps/web/dist

# Git hooks
bunx lefthook install                # Register hooks after fresh clone
bunx lefthook run pre-push           # Run manually
```
