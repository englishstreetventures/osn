# The rest of the performance checklist

The sections here are the ones this repository's eval scenarios do not
exercise, so they are kept out of `SKILL.md` to hold it under the token budget
a skill is read at. They are not less important — an unbounded read on a hot
path is the worst thing in this file — they are simply not what a diff in this
repo usually contains.

**Open this file when Step 1's routing table sends you here.** Work the section
it names one bullet at a time, exactly as you would a section in `SKILL.md`:
find the code that would carry the property, check whether it does, and record
the verdict under `## Sections checked` with the file and line you looked at.

## Loops and batching

- **N+1** — a DB call inside an iteration. Batch with `inArray`, a join, or a single `IN` statement.
- **Sequential awaits over an array** — `for (const x of xs) await f(x)` where the calls are independent. `Promise.all`/`Effect.all`.
- **Work repeated per iteration that is constant across it** — a config read, a key parse, a regex compile hoisted out of the loop.

## Indexes

- A column used in a `WHERE`, `JOIN` or `ORDER BY` with no matching index in the schema package.
- A composite predicate whose index exists but in the wrong column order to serve it.
- A uniqueness or existence probe that a partial unique index would serve — say so, and say which index.

## Unbounded reads

- A list endpoint with no `LIMIT` and no pagination.
- A count over a table that grows without bound where an indexed existence probe would do.
- A response that serialises nested data no caller reads.

## Effect runtime

- `Effect.provide(SomeLive)` inside a per-request `runPromise`. That rebuilds the layer graph on every call — a new DB connection and an OpenTelemetry SDK restart per request. The layer graph is built once at boot and threaded through route factories. See `wiki/architecture/backend-patterns.md`.
- A `yield*` chain of independent effects that `Effect.all` would run together.
- CPU-heavy synchronous work inside an effect without `Effect.sync`.

## Client fetches

- **Every full document navigation in the diff: check what it throws away.** Grep for `window.location.href =`, `location.assign(`, `location.replace(` and any `<a>` that leaves the SPA. For each hit, do three things in order: name the value the current screen was holding at that moment — the record a create or claim handler just returned is the usual one; open the destination and find the first thing it fetches; and if those are the same record, that is the finding. A full navigation drops every byte of in-memory state, so the second screen starts from nothing and fetches back what the first screen had in hand. The fix is a deliberate hand-off across the gap — a single-use `sessionStorage` key the destination reads, validates and deletes — with a fall-through to the normal fetch on any failure, so a stale or absent value costs nothing. "Cache the response" is not this fix and does not survive the navigation.
- A `createResource` that refetches on a signal change that does not affect its result.
- Waterfalled requests — a fetch that only starts once an unrelated one resolves.

## SolidJS reactivity

- A signal read outside JSX or a tracked scope, which defeats fine-grained reactivity and re-runs the whole component.
- A `createEffect` whose dependencies are broader than what it uses.
- A derived value recomputed on every read where `createMemo` would compute it once.

## Bundle and loading

- `import * as x` from a library where named imports would tree-shake.
- A route component not wrapped in `lazy()`.
- A heavy dependency pulled into a path that rarely needs it, where a dynamic `import()` would defer it.
- First-party static assets — fonts, images, generated CSS — served with no cache headers.

## Layout and event handlers

- `scroll`, `resize` or rapid input handlers with no throttle or debounce.
- A read of `scrollHeight`, `offsetHeight` or `getBoundingClientRect` interleaved with a style write in the same frame — that forces synchronous layout every time. Batch the reads before the writes.
- An observer registered per item where one on the container would do.

## Build and deploy

- **A build step that fails and still exits 0.** Check every layer that could swallow the error: a provider constructed with `throwOnError: false`, a retry that logs and continues, a warning where a throw belongs. If the deploy step runs straight after the build with no gate between them, a swallowed failure ships.
- A build guard that lives only in CI, where it cannot fire locally or on a by-hand deploy. It belongs at the end of the package's own `build` script.
- `turbo.json` tasks with `outputs` globs broader than the real output, or missing `inputs`, causing cache misses.
- A task that repeats work a dependency already did.

## Changesets

- An **empty changeset** is correct when the branch touches only the allowlisted paths in `scripts/changeset-required.sh` (`.claude/`, `.github/`, `scripts/`, `wiki/`, `docs/`, top-level prose). Do not flag it.
- A changeset is only a finding here when workspace source changed and none names the changed package. Anything more than that belongs to `prep-pr`, not this review.
