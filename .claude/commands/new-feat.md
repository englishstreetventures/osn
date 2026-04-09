Start new feature work for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for a feature name before proceeding.

Run the following two agents **in parallel**:

---

**Agent 1 — Branch prep** (general-purpose agent):

1. Run `git checkout main`
2. Run `git pull origin main`
3. Derive a kebab-case branch name from the feature description, prefixed with `feat/` (e.g. `feat/user-profile-page`)
4. Run `git checkout -b <branch-name>`
5. Report the exact branch name created

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
- The branch that was created
- The full implementation plan

---

Once the user confirms they are happy with the implementation, prompt them:

"Ready to prepare this branch for a PR? Run `/prep-pr` to validate changesets, run tests, get performance and security reviews, and push the branch."
