Start new feature work for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for a feature name before proceeding.

Run the following two agents **in parallel**:

---

**Agent 1 — Worktree prep** (general-purpose agent):

Every feature gets its own worktree and branch in the bare repo (`/Users/ac/.work/osn.git`). Never check out the feature branch in an existing worktree (`main/`, etc.).

1. Run `git fetch origin main`
2. Derive a kebab-case branch name from the feature description, prefixed with `feat/` (e.g. `feat/user-profile-page`). The worktree directory name is the branch name without the prefix (e.g. `user-profile-page`)
3. Run `git worktree add /Users/ac/.work/osn.git/<dir-name> -b <branch-name> origin/main`
4. Run `bun install` inside the new worktree (fresh worktrees have no `node_modules`)
5. Report the exact branch name and worktree path created — **all feature work happens in that worktree**, not in `main/`

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

After both agents complete, summarise:
- The branch and worktree that were created
- The full implementation plan

Then `cd` into the new worktree before starting any implementation.

---

Once the user confirms they are happy with the implementation, prompt them:

"Ready to prepare this branch for a PR? Run `/prep-pr` to validate changesets, run tests, get performance and security reviews, and push the branch."
