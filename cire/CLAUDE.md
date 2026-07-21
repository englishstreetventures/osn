# CLAUDE.md

AI coding assistant reference. For full spec see README.md. For progress/decisions see `wiki/todo/` (the per-area shards) — `wiki/TODO.md` is now a thin index.

## Quick Context

Cire is a bespoke digital wedding invite — Astro + SolidJS frontends with a Cloudflare Workers backend (Elysia + D1 + Drizzle), designed to feel tactile and animated. It lives inside the **OSN monorepo** as the `cire/` workspace (merged from cire.git, 2026-06). Packages: `cire/web` (guest site, :4321), `cire/organiser` (organiser portal, :4322), `cire/api` (backend, :8787), `cire/db` (Drizzle schema + D1 migrations). All paths in this file are relative to the OSN repo root.

Auth is a **two-system model** (see `[[wiki/systems/cire-auth]]` in the OSN wiki): guests claim a family code (`POST /api/claim` → hashed-at-rest `cire_session` cookie, `sessionAuth()` on `/api/rsvp` — no OSN account); organisers sign in with their **OSN passkey** on the portal, and `cire/api` verifies the OSN access JWT via `osnAuth()` (`@shared/osn-auth-client`) plus a per-`:weddingId` **three-tier role gate** on `/api/organiser/weddings/:weddingId/*`: `weddingOwner()` (owner-only — codes, settings, host management, delete), `weddingEditor()` (owner or `editor` co-host — module writes; viewers get 403 `read_only_role`), `weddingMember()` (any role incl. read-only `viewer` — reads + invite preview). Roles live in `wedding_hosts.role` (list + create are `osnAuth()`-only; owner = caller). The interim `X-Organiser-Token` shared secret is gone. Organisers can host **multiple** weddings — the portal lands on a wedding list/selector and a create form.

## File Responsibilities

- `README.md` → Human-readable spec, architecture, stack
- `CLAUDE.md` → AI reference — patterns, conventions, commands
- `wiki/TODO.md` → Thin index of per-area TODO shards (no tracked items live here)
- `wiki/todo/<area>.md` → Per-area progress + backlog (status, web, api, db, spreadsheet-import, security, perf, deferred, future)
- `wiki/` → Obsidian knowledge graph — architecture docs, conventions, observability, changelogs, runbooks

## wiki/todo/ Shards + Maintenance

Each shard tracks one area. Edit only the shard your diff touches — keeps PRs from conflicting on a single TODO file.

| Shard                             | What goes here                                           |
| --------------------------------- | -------------------------------------------------------- |
| `wiki/todo/status.md`             | Current Status paragraph + Up Next priority list         |
| `wiki/todo/web.md`                | `cire/web` frontend feature work                         |
| `wiki/todo/api.md`                | `cire/api` backend feature work                          |
| `wiki/todo/db.md`                 | `cire/db` schema + migrations                            |
| `wiki/todo/spreadsheet-import.md` | Organiser spreadsheet upload (parser + diff + endpoints) |
| `wiki/todo/security.md`           | H/M/L security findings                                  |
| `wiki/todo/perf.md`               | Performance concerns                                     |
| `wiki/todo/deferred.md`           | Open architectural decisions + Resolved log              |
| `wiki/todo/platform.md`           | Wedding-management platform build-out (phased checklist) |
| `wiki/todo/future.md`             | Vague post-MVP ideas                                     |

Update the relevant shard when: a task is completed, a new concern is discovered, a deferred decision is resolved, or priorities shift. Bump that shard's `last-reviewed` to today. Do **not** add tracked items to `wiki/TODO.md` — it's an index only.

## Wiki Navigation

| If you need to...               | Read                                          |
| ------------------------------- | --------------------------------------------- |
| Understand monorepo layout      | `[[wiki/architecture/monorepo-structure]]`    |
| Check PR/branch conventions     | `[[wiki/conventions/contributing]]`           |
| Understand observability rules  | `[[wiki/observability/overview]]`             |
| Look up review finding IDs      | `[[wiki/conventions/review-findings]]`        |
| Debug a production issue        | Browse `wiki/runbooks/`                       |
| Check security or perf findings | `wiki/todo/security.md` / `wiki/todo/perf.md` |
| Track progress and priorities   | `wiki/todo/status.md` (status + Up Next)      |

### Querying the Wiki

With Obsidian: open `wiki/` as a vault, use graph view and search.

Without Obsidian (CLI):

```bash
# Find pages by tag
rg "tags:.*security" wiki/ --glob "*.md"

# Find all pages linking to a topic
rg "\[\[contributing\]\]" wiki/

# List open TODOs across all shards
rg "- \[ \]" wiki/todo/

# Open TODOs in one area
rg "- \[ \]" wiki/todo/security.md
```

### Wiki Maintenance Rules

1. **New system = new wiki page** — adding a service, integration, or tool? Create a wiki page for it.
2. **Modify pattern = update wiki page** — changing a convention, flow, or architecture? Update the relevant wiki page.
3. **Frontmatter required** — every wiki page must have `title`, `tags`, `related`, `last-reviewed` in YAML frontmatter.
4. **Use `[[wiki links]]`** — all internal cross-references use Obsidian wiki link syntax.
5. **Update `last-reviewed`** — set to today's date when you modify a wiki page.

## Current State

Flat sibling-package layout under the OSN repo root (no `apps/` / `packages/` nesting — that was the standalone-repo layout, pre-merge):

```
cire/                 # workspace dir inside the OSN monorepo
├── web/              # @cire/web — Astro + SolidJS guest site (port 4321)
├── organiser/        # @cire/organiser — Astro + SolidJS organiser portal (port 4322)
├── api/              # @cire/api — Elysia on CF Workers (port 8787, wrangler dev)
├── db/               # @cire/db — Drizzle schema + D1 migrations
├── theme/            # @cire/theme — zero-dep shared theming validators (CSS-colour allow-list)
├── wiki/             # Obsidian knowledge graph (cire-internal)
├── README.md
└── CLAUDE.md         # this file
```

OSN-facing integration docs live in the **root** wiki: `[[wiki/apps/cire]]` + `[[wiki/systems/cire-auth]]`.

## Tech (one-liner)

TypeScript, Bun, Cloudflare Workers + Pages, Astro + SolidJS + Motion One, Elysia, Effect (backend + DB only), D1 + Drizzle, two-system auth (guest claim-code sessions + organiser OSN passkeys via `@shared/osn-auth-client`), Vitest, oxlint + oxfmt, lefthook, GitHub Actions

## Conventions

OSN monorepo conventions apply since the merge (root `CLAUDE.md` is authoritative); the cire-specific deltas from the standalone era that survive are listed under Key Patterns below.

- Branch: PRs required to merge to main; always work on a `feat/*` branch (osn convention — the old "merge directly, no PR review" solo rule no longer applies)
- Changesets: **required** for every PR (`bun run changeset`) — CI fails without one; package names must match workspace `name` exactly (`"@cire/api"`, not `"cire"`)
- Commits: SSH-signed; descriptive messages
- Hooks: root lefthook runs oxlint + oxfmt on staged files pre-commit, type check pre-push
- Package manager: `bun` — always use `bun run`, `bunx --bun`, `bun add`
- Monorepo: bun workspaces; scope commands with `--cwd cire/web` or `--cwd cire/api` (from the OSN repo root)
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
// bun:test — Elysia route integration test
import { describe, it, expect } from "bun:test";
import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";

const db = createDb(":memory:");
seedDb(db);
const app = createApp(db);

describe("POST /api/claim", () => {
  it("returns 401 for an unknown claim code", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        body: JSON.stringify({ publicId: "FAKE-XYZ-0000" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
```

- Test files live alongside source: `*.test.ts` co-located with the module
- Run tests: `bun run test` (all workspaces, turbo) or `bun run --cwd cire/api test`
- Integration tests use a local D1 instance via `wrangler dev` — do not mock the database
- Note: platform convention elsewhere in the monorepo is `it.effect` + `createTestLayer()` — cire alignment is tracked in root `wiki/TODO.md` (Deferred Decisions)

## Key Patterns

### Backend (Elysia on CF Workers + Effect)

- Routes in `cire/api/src/routes/` — one route factory per domain (claim, rsvp, organiser, import), composed by `createApp` in `src/app.ts`
- `createApp` uses `aot: false` — Elysia's AOT compiles handlers via `new Function`, which CF Workers forbids
- Middleware in `cire/api/src/middleware/` are Elysia plugins (scoped `derive` + `onBeforeHandle`) — `auth.ts` (`sessionAuth`, guest cookie), `osn-auth.ts` (`osnAuth`, organiser JWT via the shared Elysia adapter), the per-`:weddingId` role gates `wedding-owner.ts` / `wedding-editor.ts` / `wedding-member.ts` (owner-only vs editor-write vs any-role-read — pick the gate by the roles matrix in the root wiki's `[[wiki/systems/cire-auth]]`), `rate-limit.ts`, `turnstile.ts`. (An `ownedWedding` "single owned wedding" middleware existed pre-multi-wedding; it was removed once organisers could own several weddings.)
- POST routes pass a sentinel `parse` hook (`{ parse: () => ({}) }`) and read `request.json()` by hand, so malformed JSON degrades to the schema's 400 instead of a framework parse error
- Business logic in `cire/api/src/services/` — routes delegate to services, no logic in handlers
- Services return `Effect.Effect<A, E>` — use `Effect.runPromise` / `Effect.runSync` in route handlers to unwrap
- Error types are tagged classes extending `Data.TaggedError` — no thrown exceptions in service layer
- D1 access via Drizzle only — no raw SQL string construction
- Cloudflare env bindings typed from `wrangler types` output (`worker-configuration.d.ts`)
- Effect is backend + DB only — never import it in `cire/web` or `cire/organiser`

### Frontend (Astro + SolidJS)

- Astro pages in `cire/web/src/pages/` (and `cire/organiser/src/pages/`) — `.astro` files for static shells
- SolidJS islands for interactive components — `client:load` or `client:visible` as appropriate
- Page-level transitions: Astro View Transitions API
- Component-level animations: `@motionone/solid`
- Keep animation logic in `*.motion.ts` files co-located with components

## Commands

All commands run from the **OSN repo root**.

```bash
# Dev
bun run dev:cire                     # cire API + web + organiser, plus @osn/api (organiser sign-in needs the OSN issuer)
bun run --cwd cire/web dev           # Guest site only (:4321)
bun run --cwd cire/organiser dev     # Organiser portal only (:4322)
bun run --cwd cire/api dev           # API only (Bun.serve local entry, :8787; wrangler via dev:wrangler)

# Build
bun run build                        # Build all packages (turbo)
bun run --cwd cire/web build
bun run --cwd cire/api build

# Test
bun run test                         # All packages (turbo)
bun run --cwd cire/api test
bun run --cwd cire/web test
bun run --cwd cire/organiser test    # SolidJS islands (vitest + happy-dom)

# Lint + Format (root config)
bun run lint                         # oxlint
bun run fmt                          # oxfmt
bun run fmt:check                    # CI check

# Database (from cire/api — wrangler.toml lives there)
cd cire/api && bunx wrangler d1 migrations apply cire-db --local   # Local migrations
cd cire/api && bunx wrangler d1 migrations apply cire-db            # Production
cd cire/api && bunx wrangler types                                  # Regenerate CF binding types

# Deploy
cd cire/api && bunx wrangler deploy --env production                # Deploy API worker (prod env — never bare `wrangler deploy`, which the config now blocks)
# Guest site is a Worker (NOT Pages): the adapter emits dist/server + dist/client
# and a generated dist/server/wrangler.json extending cire/web/wrangler.jsonc.
# CI strips the unsupported `legacy_env` field first — see deploy.yml.
bun run --cwd cire/web build && (cd cire/web && bunx wrangler deploy --config dist/server/wrangler.json)

# Versioning
bun run changeset                    # Create changeset (required for every PR)
```
