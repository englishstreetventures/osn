# AGENTS.md

The entry point for coding agents. It holds what every session needs; the rest is one step away. `README.md` is the spec for humans, `wiki/` is the knowledge base (start at `wiki/index.md`), and `.claude/skills/` holds the procedures.

## The project

OSN is a modular social platform: people own their identity and social graph, and apps opt in or out on their own. The monorepo is split by domain:

| Dir | Prefix | What lives here |
|---|---|---|
| `osn/` | `@osn/*` | **OSN, the system**: the headless identity core (auth, graph, orgs, OIDC provider, SDK) and `@osn/auth-ui` |
| `musubi/` | `@musubi/*` | **Musubi, our implementation** of it: the identity and social app, and its marketing site |
| `pulse/` | `@pulse/*` | Events: app, API, DB, marketing site |
| `zap/` | `@zap/*` | Messaging: API and DB, no client yet |
| `cire/` | `@cire/*` | Wedding invites: guest site, organiser portal, vendor portal, marketing site, API, DB, `@cire/ui` |
| `shared/` | `@shared/*` | Libraries every product uses: UI primitives, design tokens, crypto, email, observability, rate limiting, auth client |

Which name a new package takes is in `wiki/shared/osn-and-musubi.md`; the full tree is in `wiki/shared/monorepo-structure.md`.

**Stack:** Bun, TypeScript, Elysia, Effect v4 (backend only), Drizzle, `bun:sqlite` locally and Cloudflare D1 when deployed, SolidJS, Astro, Turborepo, oxlint, oxfmt, Vitest.

**Deployed** on Cloudflare: identity on `musubi.social` (the `osn-api` Worker on `id.musubi.social`), cire on `cireweddings.com`. A merge to `main` deploys the dev tier (`*.dev.…`) at once; production waits for a human to approve the `production` GitHub Environment. See `wiki/shared/dev-environment.md`.

## How work runs

- **Feature and fix work starts with `/new-feat`**: it takes or opens the issue, cuts the branch, writes `NEW-FEAT.md` and runs `/stress-plan` on the plan before any code exists. Skip it only for a one-line change on a branch that already exists. Resuming a branch, read `NEW-FEAT.md` first.
- **It ends with `/prep-pr`, then `/retro`** (`/retro-v2` when the session is short of budget). `/retro` writes the session-metrics card; nothing else does.
- **Never commit to `main`.** Every change goes through a pull request. Several pull requests for one goal are stacked: `wiki/conventions/stacked-prs.md`.
- **Start sessions inside a worktree** (`~/.work/osn.git/<dir>`), never in the bare parent, which has no working tree and none of this configuration.
- **Choose subagents by definition** with the `pick-agent` skill; `.claude/agents/*.md` sets each role's model and effort. Only one code-writing agent per worktree.

## Issues

Work is tracked in GitHub Issues, never the wiki.

- `xchromo/osn` (public) holds product work, ops, docs and schema.
- `xchromo/osn-tracker` (private) holds **every** security (`S-`), performance (`P-`) and compliance (`C-`) finding, however minor. Route by kind, not severity: a finding names an unpatched route. Never link a tracker issue from a public file; state the constraint instead.
- Each issue carries one `product:` label, an org type (`Feature`, `Bug`, `Task`) and a `complexity:` rating set **before** work starts (the `rate-complexity` skill). The full label scheme is in `wiki/conventions/github-issues-setup.md`; how to file a finding is in `wiki/conventions/review-findings.md`.
- A body must stand on its own months later: name the file and line, state the fix or what "done" looks like, spell out acronyms, and cite wiki pages by repo path, since a `[[wikilink]]` does not resolve on GitHub.
- When the next step needs a choice only the owner can make, write the proposal, add `needs:decision`, and move to another issue.
- Never delete an issue; close it.

## Standing rules

- **Changesets.** A pull request that touches a versioned package needs one (`bun run changeset`), named by the workspace's exact `name`. Never mix version-less packages (`@cire/*`) with versioned ones in one changeset. Check whether one is needed with `git diff --name-only origin/main...HEAD | bash scripts/changeset-required.sh` — always pipe the diff in. CI versions on merge; never run `bun run version`. Details: `wiki/conventions/contributing.md`.
- **Installs.** Never a bare `bun install`: it drops lockfile entries for other platforms. Use `bun install --frozen-lockfile`, and `bun add <pkg> --cwd <dir>` (not `--filter`) to add a dependency. A lockfile diff bigger than the dependency you changed is wrong. Run tooling as `bunx --bun`.
- **Tests** live in `tests/` at the package root, mirroring `src/` — never beside the source, and no test helpers in `src/`. The one exception is the Miniflare D1 tier (`tests/d1/`, cire's `tests/db/`), which only `bun run test:d1` runs. Patterns: `wiki/conventions/testing-patterns.md`.
- **Effect.** Build the layer graph once, as a `ManagedRuntime` at boot; never `Effect.provide` a database or observability layer inside a per-request `runPromise`. The v3 forms that no longer compile are in `wiki/shared/effect-v4-api.md`. TypeBox validates at the HTTP boundary and Effect Schema in services; never mix them. Frontends do not use Effect.
- **Observability.** No `console.*`, no raw OpenTelemetry constructors, no unbounded metric attributes. See `wiki/shared/observability/overview.md`.
- **Cross-origin cookies.** The identity API is on a different origin from every app, so any browser `fetch` that sets or reads the session cookie must pass `credentials: "include"`. Without it the browser drops `Set-Cookie` silently. Check this first when a sign-in "succeeds" but the user stays signed out.
- **Comments** state what the code guarantees now — never a tracker ID, finding tag or history. See `wiki/conventions/code-comments.md`.
- **Deferrals** get an issue, and the code carries only the link: `// Bounded until xchromo/osn#412 lands.` A settled choice with its reason can stay inline.
- **Instruction files state the present.** This file, a `SKILL.md` or a wiki page says what to do now, never how it came to be; `git log` holds that. A reason that stops a mistake stays.
- **House lint rules** (`house/*` in `tools/oxlint/house`) and why they exist: `wiki/conventions/house-lint-rules.md`. Agent skills, evals and vendored trees: `wiki/conventions/agent-tooling.md`.
- Lefthook formats and lints staged files on commit and type-checks on push.

## Commands

```bash
bun run dev                  # every dev server; or dev:osn, dev:social, dev:pulse, dev:zap,
                             # dev:cire, dev:apis, dev:landing, dev:lab
bun run build | check | lint | fmt
bun run test                 # all packages
bun run test:d1              # Miniflare D1 tier
bun run test:browser         # real-Chromium tier
bun run test:scripts         # bun tests under scripts/
bun run --cwd <pkg> test:run # one Vitest package, once
bun run --cwd <pkg> test     # @cire/api, @cire/db, @tools/oxlint-house use bun test
```

Database commands differ between cire and the rest; see `wiki/conventions/commands.md` and `wiki/cire/cire-development.md`.

Dev servers answer on named HTTPS hosts through portless (`https://id.musubi.localhost`, `https://host.cire.localhost`), and a linked worktree gets its own stack under a branch prefix. `PORTLESS=0 bun run dev` uses fixed ports. Setup and the host table: `wiki/conventions/devloop-urls.md`. Astro puts `astro dev` in the background when it sees an agent, which breaks the route: run `CLAUDECODE= bun run dev`.

The shell is fish locally and bash remotely. Quote glob arguments (`--include='*.ts'`), and never put a heredoc inside `$(…)`; write a long commit message to a file and use `git commit -F`.

## The wiki

`wiki/` is one Obsidian vault for the whole monorepo, with folders that mirror it: one per product (`osn/`, `musubi/`, `pulse/`, `cire/`, `zap/`), `shared/` for what applies to all of them, and `conventions/`, `decisions/`, `compliance/`. Start at `wiki/index.md`, or search it:

1. The Obsidian MCP (`mcp__obsidian-wiki__*`) — local machine with Obsidian open only.
2. The `obsidian` CLI — same limits.
3. `grep -rn "term" wiki/ --include='*.md'` — works everywhere.

The first two read `main`'s wiki, not your branch's, and must never write. If `git diff --name-only origin/main...HEAD -- wiki/` lists a page, read that page with Read. More in `wiki/conventions/wiki-search.md`.

**Invoke the `write-wiki` skill before editing any page under `wiki/`.** A change to a pattern updates its wiki page in the same pull request.

Pages most sessions need:

| To... | Read |
|---|---|
| Write a backend route or service | `wiki/shared/backend-patterns.md`, `wiki/shared/schema-layers.md` |
| Write frontend code, or hit a rendering bug tests cannot see | `wiki/shared/frontend-patterns.md` |
| Use or add a UI component, or colour one | `wiki/shared/component-library.md`, `wiki/shared/design-tokens.md` |
| Work on one product | its folder, `wiki/<product>/` — the overview page and its systems and runbooks; cire's build rules are in `wiki/cire/cire-development.md` |
| Understand accounts, sessions and sign-in | `wiki/osn/identity-model.md`, `wiki/osn/sessions.md` |
| Check a D1 or free-tier limit | `wiki/shared/d1-limits.md`, `wiki/shared/free-tier-limits.md` |
| Deploy, or debug a deployed Worker | `wiki/shared/production-deploy.md`, the `debug-workers` skill |
| Write a test that needs real CSS or layout | `wiki/conventions/browser-tests.md` |
