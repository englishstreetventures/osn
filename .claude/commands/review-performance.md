Analyse the current branch diff for performance concerns. $ARGUMENTS may contain a list of changed workspaces and a branch name; if not provided, derive them from `git diff --name-only main...HEAD`.

Read all changed source files in the affected workspaces and examine them for the following issues:

---

## Backend (osn/core, osn/db, pulse/api, pulse/db)

- **N+1 queries** — loops that issue DB calls inside iterations instead of batching with `inArray` or a join
- **Missing indexes** — columns used in `WHERE`/`JOIN` in Drizzle queries that have no corresponding index in the schema
- **Unbounded queries** — list endpoints without `LIMIT` / pagination
- **Blocking operations in Effect pipelines** — synchronous CPU-heavy work not wrapped in `Effect.sync` / `Effect.promise`, or `yield*` chains that could be parallelised with `Effect.all`
- **Large serialised payloads** — JSON responses that include unnecessary nested data or could be streamed
- **WebSocket fan-out** — message broadcasting that iterates all connections in O(n) without grouping or batching

## Frontend (pulse/app, osn/landing, osn/ui)

- **Unnecessary SolidJS re-renders** — signals read outside of JSX or tracked contexts (defeating fine-grained reactivity), or `createEffect` with broad dependencies
- **Heavy bundle imports** — importing entire libraries (`import * as _`) where tree-shaking would suffice; or missing dynamic `import()` for large code paths
- **Missing lazy-loading** — route components not wrapped in `lazy()` in SolidJS router
- **Unthrottled event handlers** — scroll, resize, or rapid input handlers without `throttle`/`debounce`

## Build & CI

- **Turbo cache misses** — overly broad `outputs` globs or missing `inputs` declarations in `turbo.json` tasks that cause unnecessary re-runs
- **Redundant build steps** — tasks that duplicate work already handled by a dependent task in the pipeline

## Changesets

- An **empty changeset** (frontmatter fences only, no package entries) is correct and expected when the branch contains only CI/infra changes (`.claude/`, `.github/`, `turbo.json`, `lefthook.yml`, root `package.json`, `.changeset/` itself). Do not flag this as an issue.
- Only flag a missing or empty changeset as a concern if workspace package source files were also changed.

---

---

## Finding format

Number each finding with a short ID: `P-C1`, `P-C2`, … for Critical; `P-W1`, `P-W2`, … for Warning; `P-I1`, … for Info. Increment the counter within each tier across the full report. This lets findings be referenced unambiguously (e.g. "address P-C1 before merging").

Each finding must use this exact structure:

```
**P-W1** — <short title>
**Issue:** What the problem is, stated concisely.
**Why:** Why this is a performance concern — the failure mode, the scale at which it bites, or the measurable impact.
**Solution:** What was changed or what needs to be done.
**Rationale:** Why this solution correctly addresses the bottleneck.
```

Tier definitions:
- **Critical (P-C)** — will cause measurable degradation in production (e.g. unbounded query on a hot path)
- **Warning (P-W)** — likely to cause issues under load or as the codebase grows
- **Info (P-I)** — minor inefficiency or best-practice suggestion

If no concerns are found, state that explicitly: "No performance concerns found."
