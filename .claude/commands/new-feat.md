Start new feature work for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for a feature name before proceeding.

---

**Step 0 — the issue comes first.** Every branch traces to an issue, so the work is visible before it starts, not after.

If $ARGUMENTS is an issue number or URL (`#412`, `xchromo/osn#412`), take that issue:

```bash
gh issue view 412 --repo xchromo/osn --json number,title,body,labels
```

Otherwise open one:

```bash
gh issue create --repo xchromo/osn \
  --title "<short imperative title>" \
  --type Feature \
  --label "product:<osn-core|pulse|cire|zap|shared|landing>" \
  --body "<what and why, in a couple of sentences>"
```

`--type` is an org-level field the Project groups and filters on, separate from the labels. `Feature` for new capability, `Bug` for something already built behaving wrongly, `Task` for the rest — a migration, a chore, a piece of infrastructure.

There is no `area:feature` label: an issue with no `area:` is ordinary product work, which is what the type already says. Add an `area:` only when the work is a finding, or is `ops`, `schema` or `docs`.

Two things follow from the issue:

- **The branch name.** Kebab-case the issue title and prefix it — `feat/guest-list-filtering`. Pass this to Agent 1; it does not derive its own.
- **Status.** Move the issue to **In Progress** in the **OSN Platform** project. `gh project item-edit` needs the `project` scope; if it is missing, say so and move it in the UI rather than skipping it.

Work that fixes a review finding is the exception — that issue already exists in `xchromo/osn-tracker`. Take it by number, do not open a duplicate in the public repo, and keep the finding's text out of the public branch name.

---

**Then detect the environment** — the branch setup differs between a personal terminal and the Claude Code remote (web/cloud) environment.

Run this check:

```bash
if [ -d /Users/ac/.work/osn.git ] && [ "$(uname)" = "Darwin" ]; then echo PERSONAL; else echo REMOTE; fi
```

- **PERSONAL** — local macOS terminal with the bare repo at `/Users/ac/.work/osn.git`. Use the **worktree** flow (Agent 1A).
- **REMOTE** — Claude Code remote execution environment (Linux container). The repo is already cloned fresh into the working directory and a designated `claude/*` development branch is assigned for the session. There is no bare repo and no worktrees. Use the **in-place branch** flow (Agent 1B).

Then run **two agents in parallel**: the environment-appropriate variant of Agent 1, plus Agent 2.

---

**Agent 1A — Worktree prep (PERSONAL only)** (general-purpose agent):

Every feature gets its own worktree and branch in the bare repo (`/Users/ac/.work/osn.git`). Never check out the feature branch in an existing worktree (`main/`, etc.).

1. Run `git fetch origin main`
2. Use the branch name from Step 0 — derived from the issue title, prefixed with `feat/` (e.g. `feat/user-profile-page`). The worktree directory name is the branch name without the prefix (e.g. `user-profile-page`)
3. Run `git worktree add /Users/ac/.work/osn.git/<dir-name> -b <branch-name> origin/main`
4. Run `bun install` inside the new worktree (fresh worktrees have no `node_modules`)
5. Report the exact branch name and worktree path created — **all feature work happens in that worktree**, not in `main/`

---

**Agent 1B — In-place branch prep (REMOTE only)** (general-purpose agent):

The remote environment already has the repo checked out in the working directory and `node_modules` installed. Do **not** create a worktree (there is no bare repo) and do **not** run `bun install` again unless it is missing. Work in the existing checkout.

1. Run `git fetch origin main`
2. Determine the branch:
   - If the session has a **designated development branch** (a `claude/*` branch named in the task/environment setup), use that exact branch name — do not invent a `feat/*` name. **Never push to a different branch without explicit permission.**
   - Otherwise, use the `feat/*` branch name from Step 0.
3. Create/switch to the branch on top of the latest main: `git checkout -B <branch-name> origin/main` (use `-B` so re-running is idempotent; if you have uncommitted work in progress, switch without resetting instead).
4. Report the exact branch name and that work proceeds in the current working directory.

---

**Agent 2 — Feature planner** (Plan subagent):

Explore the OSN codebase and produce a concise implementation plan for the feature described in $ARGUMENTS.

**Start in the wiki, not in the source.** The systems this feature touches almost certainly have a page describing their contract, their finding history, and their observability — cheaper to read than to reconstruct from code. Follow the three-tier ladder in the "Searching the wiki" section of `CLAUDE.md`: Obsidian MCP (`search_vault_smart` for meaning, `get_note_outline` before reading a whole page, `get_backlinks` to find what else depends on it), else the `obsidian` CLI (`obsidian:obsidian-cli` skill), else grep. Then go to the source to confirm what the pages claim.

The plan should:

- Identify relevant existing files and patterns (Effect.ts services, Elysia routes, Drizzle schema, SolidJS frontend)
- Cite the wiki pages that cover the affected systems, and name which of them this feature will make stale — `/prep-pr` Step 7 has to update every one, so finding them now is cheaper than finding them at PR time
- List the files that need to be created or modified
- Outline the implementation steps in order
- Flag any Effect.ts, WebSocket, or E2E encryption considerations
- Note if a changeset will be needed (it always is)
- **Observability plan** — for every new service, route, or service-layer function, spell out what gets instrumented. Specifically:
  - **Logs**: which error paths use `Effect.logError`; any new secret fields that need adding to the redaction deny-list; confirm no `console.*` calls
  - **Traces**: which service functions get `Effect.withSpan("<domain>.<operation>")`; confirm any outbound HTTP goes through `instrumentedFetch` from `@shared/observability/fetch`
  - **Metrics**: which new counters/histograms (if any) get added to the relevant `metrics.ts` file (`pulse/api/src/metrics.ts`, `osn/core/src/metrics.ts`, `osn/crypto/src/arc-metrics.ts`, …); confirm they follow the `{namespace}.{domain}.{subject}.{measurement}` naming and that the attribute type is a bounded string-literal union (no userId / requestId / eventId in attributes — those go in spans/logs)
  - See the "Observability" section in `CLAUDE.md` for the full rules and canonical code example.

---

**Skills to use while implementing** (invoke these — don't reinvent what a skill already encodes):

| Part of the task                                                                                | Skill to invoke                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Any new UI — components, pages, layouts, visual/UX work                                         | `frontend-design` (then review the result with `web-design-guidelines` for accessibility)               |
| Page-load / Core Web Vitals profiling                                                           | `web-perf`                                                                                              |
| Anything Cloudflare (Workers, Pages, KV, **D1**, **R2**, Images, AI, caching, bindings, config) | `cloudflare`; writing/reviewing Worker code → `workers-best-practices`; running `wrangler` → `wrangler` |
| Durable Objects (stateful coordination, RPC, alarms, WebSockets) | `durable-objects` |
| Cloudflare Agents SDK / durable workflows / scheduled agents / MCP servers | `agents-sdk` |
| Sandboxed / untrusted code execution | `sandbox-sdk` |
| Sending or routing transactional email | `cloudflare-email-service` |
| Turnstile / CAPTCHA / bot protection on a form | `turnstile-spin` |
| Building an AI agent (tools, structured output, streaming) | `building-pydantic-ai-agents` (or `claude-api` for Anthropic SDK / model/pricing questions) |
| Implementing any feature or bugfix logic | `test-driven-development` (write the failing test first) |
| A bug, test failure, or unexpected behavior | `systematic-debugging` |
| The feature is ambiguous / needs product direction | `brainstorming` **with the user first**, before implementing |
| Importing from / pushing to Figma designs | the `figma-*` skills (`figma-use`, `figma-generate-design`, …) |
| Writing or restructuring any page under `wiki/` (also `CLAUDE.md`, `README.md`) | `obsidian:obsidian-markdown` — wikilinks, callouts, embeds, properties, block IDs. See "Writing to the wiki" in `CLAUDE.md` for what survives on GitHub |
| Searching the wiki from the `obsidian` CLI | `obsidian:obsidian-cli` (local machine, Obsidian running). **Read only** — its write commands hit `main`'s worktree, not your branch |
| Reading a vendor doc, RFC, or advisory from a URL | `obsidian:defuddle` if `defuddle` is installed (`npm install -g defuddle`) — `defuddle parse <url> --md` strips the page chrome and costs far fewer tokens than WebFetch. Not for `.md`/raw URLs; those are already clean |
| A page-shaped set of records in the wiki (backlog, inventory, status board) that a table can no longer hold | `obsidian:obsidian-bases` for a `.base` view — **only alongside the prose**, never instead of it (renders in Obsidian only) |
| A phase graph, dependency graph, or task graph worth seeing spatially | `obsidian:json-canvas` for a `.canvas` — same Obsidian-only caveat; keep mermaid in the page for everyone else |

If none apply, proceed with the repo's own conventions (root + area `CLAUDE.md`). When unsure whether a skill fits, invoke it — a wrong fit costs little.

---

After both agents complete, summarise:

- The issue number and its Status in the project
- The branch that was created (and, on PERSONAL, the worktree path)
- The full implementation plan

Then, on PERSONAL, `cd` into the new worktree before starting any implementation. On REMOTE, implementation proceeds in the current working directory on the checked-out branch — no `cd` needed.

---

Once the user confirms they are happy with the implementation, prompt them:

"Ready to prepare this branch for a PR? Run `/prep-pr` to validate changesets, run tests, get performance and security reviews, and push the branch."
