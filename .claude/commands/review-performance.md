Analyse the current branch diff for performance concerns. $ARGUMENTS may contain affected paths and a branch name; if not provided, derive from `git diff --name-only main...HEAD`.

Read all changed source files and examine for:

---

## Backend (Hono on Cloudflare Workers)

- **N+1 queries** — Drizzle queries inside loops instead of batching with `inArray()` or joins
- **Missing indexes** — columns used in WHERE/JOIN/ORDER BY with no corresponding index in the Drizzle schema
- **Unbounded queries** — list endpoints without `.limit()` / pagination
- **Missed parallelism** — sequential `await` calls in route handlers that could be `Promise.all()`
- **Large serialised payloads** — responses including unnecessary nested guest or event data
- **Synchronous CPU work** — heavy computation in a Worker without regard for the 50ms CPU time limit on the free tier
- **D1 round-trips** — multiple sequential D1 queries that could be combined, batched, or cached

---

## Frontend (Astro + SolidJS)

- **Animation blocking LCP** — Motion One or View Transitions initialisation that delays largest contentful paint; animations should defer until after first paint
- **Unnecessary re-renders** — SolidJS signals read outside JSX or tracked contexts (defeats fine-grained reactivity); `createEffect` with overly broad dependencies
- **Missing lazy-loading** — large SolidJS islands using `client:load` where `client:visible` or `client:idle` would suffice
- **Heavy bundle imports** — importing entire libraries where tree-shaking or dynamic `import()` would reduce bundle size
- **Unthrottled event handlers** — scroll, resize, or rapid input handlers without throttle/debounce

---

## Build

- **Redundant build steps** — workspaces rebuilding unchanged packages unnecessarily
- **Missing bun workspace caching** — build tasks without proper input/output declarations

---

Report findings with these labels:

- **Critical** — measurable production degradation (e.g. unbounded D1 query on hot path, Worker CPU limit exceeded)
- **Warning** — likely to cause issues under load or as codebase grows
- **Info** — minor inefficiency or best-practice suggestion

If no concerns are found, state: "No performance concerns found."
