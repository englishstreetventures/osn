Start new feature work for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for a feature name before proceeding.

---

**First, detect the environment** — the branch setup differs between a personal terminal and the Claude Code remote (web/cloud) environment.

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
2. Derive a kebab-case branch name from the feature description, prefixed with `feat/` (e.g. `feat/user-profile-page`). The worktree directory name is the branch name without the prefix (e.g. `user-profile-page`)
3. Run `git worktree add /Users/ac/.work/osn.git/<dir-name> -b <branch-name> origin/main`
4. Run `bun install` inside the new worktree (fresh worktrees have no `node_modules`)
5. Report the exact branch name and worktree path created — **all feature work happens in that worktree**, not in `main/`

---

**Agent 1B — In-place branch prep (REMOTE only)** (general-purpose agent):

The remote environment already has the repo checked out in the working directory and `node_modules` installed. Do **not** create a worktree (there is no bare repo) and do **not** run `bun install` again unless it is missing. Work in the existing checkout.

1. Run `git fetch origin main`
2. Determine the branch:
   - If the session has a **designated development branch** (a `claude/*` branch named in the task/environment setup), use that exact branch name — do not invent a `feat/*` name. **Never push to a different branch without explicit permission.**
   - Otherwise, derive a kebab-case `feat/*` branch name from the feature description.
3. Create/switch to the branch on top of the latest main: `git checkout -B <branch-name> origin/main` (use `-B` so re-running is idempotent; if you have uncommitted work in progress, switch without resetting instead).
4. Report the exact branch name and that work proceeds in the current working directory.

---

**Agent 2 — Feature planner** (Plan subagent):

Explore the OSN codebase and produce a concise implementation plan for the feature described in $ARGUMENTS.

The plan should:
- Identify relevant existing files and patterns (Effect.ts services, Elysia routes, Drizzle schema, SolidJS/Tauri frontend)
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

| Part of the task | Skill to invoke |
|---|---|
| Any new UI — components, pages, layouts, visual/UX work | `frontend-design` (then review the result with `web-design-guidelines` for accessibility) |
| Page-load / Core Web Vitals profiling | `web-perf` |
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

If none apply, proceed with the repo's own conventions (root + area `CLAUDE.md`). When unsure whether a skill fits, invoke it — a wrong fit costs little.

---

After both agents complete, summarise:
- The branch that was created (and, on PERSONAL, the worktree path)
- The full implementation plan

Then, on PERSONAL, `cd` into the new worktree before starting any implementation. On REMOTE, implementation proceeds in the current working directory on the checked-out branch — no `cd` needed.

---

Once the user confirms they are happy with the implementation, prompt them:

"Ready to prepare this branch for a PR? Run `/prep-pr` to validate changesets, run tests, get performance and security reviews, and push the branch."
