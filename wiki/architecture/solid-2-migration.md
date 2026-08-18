# Solid 1 → Solid 2 migration plan

Status: **plan only, nothing started**. Written 2026-08-19 against `solid-js@2.0.0-rc.0`.

Eleven workspace packages render with Solid. This page says what breaks, what is
not ready upstream, and the order to do the work in.

The short version: the framework itself is ready enough (RC), but four of our
dependencies have no Solid 2 build at all, and two of those are abandoned. Most
of the cost is not in the Solid API renames — it is in getting off those four.

---

## 1. What we run today

| Package | Kind | Solid deps | Size |
| --- | --- | --- | --- |
| `cire/host` | Astro + islands | astro-solid, kobalte, solid-dnd, solid-toast, rp-auth | 191 files |
| `cire/invites` | Astro + islands | astro-solid, solid-toast, rp-auth | 129 files |
| `cire/vendor` | Astro + islands | astro-solid, kobalte, solid-toast, rp-auth | 53 files |
| `cire/landing` | Astro + islands | astro-solid | 34 files |
| `osn/landing` | Astro + islands | astro-solid | 17 files |
| `pulse/landing` | Astro + islands | astro-solid | 17 files |
| `pulse/web` | SolidStart (SPA, `ssr: false`) | start, router, meta, solid-toast, `@osn/ui`, rp-auth | 106 files |
| `osn/social` | plain Vite SPA | router, solid-toast, `@osn/ui`, `@osn/client` | 51 files |
| `osn/ui` | library | kobalte, solid-toast, `@osn/client` | 48 files |
| `osn/client` | library | solid peer only | 43 files |
| `shared/rp-auth` | library | solid peer only | 4 files |

Internal graph — three libraries feed everything else:

```
@osn/client ──> @osn/ui ──┬─> osn/social
                          └─> pulse/web
@shared/rp-auth ──────────┬─> cire/host, cire/invites, cire/vendor
                          └─> pulse/web
```

`@cire/theme` and `@cire/invite-designs` hold no Solid code — ignore them.

`cire/landing`, `osn/landing` and `pulse/landing` have no workspace Solid deps.
They are the only packages that can move alone.

---

## 2. Upstream readiness (checked 2026-08-19)

| Dependency | Solid 2 build | Published | Verdict |
| --- | --- | --- | --- |
| `solid-js` | `2.0.0-rc.0` | 2026-08-12 | RC |
| `@solidjs/web` | `2.0.0-rc.0` | 2026-08-12 | RC |
| `@solidjs/router` | `2.0.0-next.16` | 2026-08-12 | pre-release, we only use nav primitives |
| `@solidjs/meta` | `1.0.0-next.2` | 2026-08-13 | pre-release |
| `vite-plugin-solid` | `3.0.0-next.27` | 2026-08-12 | pre-release, now wraps `@solidjs/vite-plugin` |
| `@solidjs/testing-library` | `1.0.0-beta.2` | 2026-06-25 | beta, 2 months stale |
| `@kobalte/core` | `2.0.0-alpha.0` | 2026-08-13 | alpha, own breaking changes on top |
| `@astrojs/solid-js` | **none** | 7.0.2 pins `solid-js@^1.9.13` | **blocker — 6 packages** |
| `@solidjs/start` | **none** | 2.0.1 still depends on `solid-js@^1.9.14` | **blocker — `pulse/web`** |
| `solid-toast` | **none** | last published 2023-03 | **dead — 6 packages** |
| `@thisbeyond/solid-dnd` | **none** | last published 2023-11 | **dead — `cire/host`** |

Two of these we can route around ourselves; two we cannot.

- **`@astrojs/solid-js`** — the whole integration is ~13 KB of source across six
  files (`index.ts`, `client.ts`, `server.ts`, `context.ts`, `container-renderer.ts`,
  `types.ts`). It imports `Suspense` from `solid-js`, `createStore`/`reconcile`
  from `solid-js/store`, and `createComponent`/`hydrate`/`render`/`renderToString`/
  `renderToStringAsync`/`ssr` from `solid-js/web`. Every one of those moves in 2.0.
  Forking it into a workspace package is the plan. There is no open upstream issue
  tracking Solid 2 support, so waiting has no date attached.
- **`@solidjs/start`** — no Solid 2 line exists, not even a pre-release.
  But `pulse/web` runs `solidStart({ ssr: false })`, and uses Start for exactly
  three things: `mount`/`StartClient`, `FileRoutes`, and `createHandler`/`StartServer`.
  It is a client-rendered SPA wearing a meta-framework. Dropping Start for plain
  Vite + `@solidjs/router` — the shape `osn/social` already has — removes the
  blocker entirely and is worth doing on its own merits.
- **`solid-toast`** — three years unpublished. Replace with a small in-house
  toast in `@osn/ui`. Used in 4 files there plus scattered call sites in
  `cire/host` (30), `cire/invites` (22), `pulse/web` (22), `osn/social` (7),
  `cire/vendor` (6) — all `import { toast } from "solid-toast"` then `toast.success(...)`,
  so a same-shaped replacement keeps the call sites untouched.
- **`@thisbeyond/solid-dnd`** — three years unpublished, used only for the
  drag-reorder in `cire/host/src/components/EventsEditor.tsx`. Replace with the
  HTML5 drag-and-drop API or `@formkit/drag-and-drop` (framework-agnostic).

---

## 3. What Solid 2 breaks in our code

Counts are matched call sites in our own source, excluding `node_modules` and
`dist`.

### Mechanical — safe to codemod

| Change | Sites | Where |
| --- | --- | --- |
| `solid-js/web` → `@solidjs/web` | 8 | host 6, invites 1, social 1 |
| `solid-js/store` → `solid-js` | 2 | host |
| `jsxImportSource: "solid-js"` → `"@solidjs/web"` | 7 | `shared/typescript-config/solid.json` + 6 app tsconfigs |
| `Suspense` → `Loading` | 41 | host 22, social 10, vendor 6, pulse/web 2, ui 1 |
| `mergeProps` → `merge` | 0 | — |
| `unwrap` → `snapshot` | 1 | host |
| `<Index>` → `<For keyed={false}>` | 2 | host |
| `Ctx.Provider` → `<Ctx value=…>` | 26 | social 20, client 4, rp-auth 2 |
| `onMount` → `onSettled` | 139 | host 54, invites 36, vendor 17, ui 11, pulse/web 10, social 6, cire/landing 6, osn/landing 5, pulse/landing 4 |
| drop `batch(…)` | 7 | invites |
| drop `produce(…)` (now the default) | 6 | host |

### Needs judgement — not a rename

**`splitProps` → `omit` (71 sites: ui 48, host 13, vendor 8, social 2).**
`omit` returns only the rest object; there is no `local`. Every
`const [local, others] = splitProps(props, ["class"])` becomes
`const others = omit(props, "class")` with `local.class` rewritten to
`props.class`. `@osn/ui` alone is 48 of these and they are near-identical, so a
scripted rewrite plus review is realistic.

**`classList` → `class` object/array form (88 sites: host 28, invites 26,
pulse/web 22, cire/landing 10, social 1, pulse/landing 1).**
`class="card" classList={{active: x()}}` becomes `class={["card", {active: x()}]}`.
Mechanical per site, but the two attributes have to merge, so it is a rewrite not
a rename. `cire/landing` also has 2 `class:` namespace uses, which are gone.

**`createResource` → async `createMemo` + `<Loading>` (106 sites across ~40 files).**
The single biggest axis. Data fetching is **not** centralised — it is inline in
page and component files across every app. `resource.loading` maps to a `Loading`
boundary or `isPending`, `resource.error` to `Errored`, `refetch()` to `refresh()`,
`mutate()` to `createOptimisticStore` + `action`. Expect the shape of components
to change, not just their imports. Worst concentrations: `pulse/web` 35,
`osn/social` 15, `cire/host` 10, `cire/invites` 10, `cire/vendor` 10, `osn/ui` 8.

**`createEffect` splits into compute → apply (72 sites: host 27, invites 21,
pulse/web 12, vendor 6, social 4, ui 2, client 2).**
One function becomes two: a tracked compute returning a value, and an apply that
takes it and returns cleanup. Any `onCleanup` inside an effect body moves to a
returned cleanup function. Cannot be codemodded safely.

**Ref callbacks are now unowned (152 `ref={` sites).**
`getOwner()` is `null` inside a ref callback, so `onCleanup` registered there
silently stops working. Any `ref={el => {…; onCleanup(…)}}` has to move to
`onSettled` in the component body or become a directive factory. Grep for
`onCleanup` inside ref callbacks before touching anything — a missed one is a
listener leak that no test will catch.

**Batching is now microtask-deferred.**
`setCount(1); count()` returns the old value until the batch flushes. This is the
change most likely to break tests that assert straight after a setter, and 155
files import `@solidjs/testing-library`. Expect to add `flush()` broadly.

**Dev diagnostics will throw, not just warn.**
Writing to a signal inside a reactive scope throws in dev. Reading reactively at
the top of a component body warns — including destructured props. We do not have
a count for this; it surfaces at runtime, so budget debugging time.

### Not our problem

No `use:` directives (the one grep hit is a comment). No `observable`/`from`,
no `createComputed`, no `createMutable`, no `createDeferred`, no `createSelector`,
no `startTransition`/`useTransition`, no `SuspenseList`, no `/*@once*/`, no
`attr:`/`bool:`/`on:` namespaces, no `clearDelegatedEvents`. Every `onError` hit
in the repo is an Elysia handler or an `<img onError>`, not Solid's.

The five `createContext<T>()` calls are all default-less with hand-written
throw-wrappers — in 2.0 `useContext` returns `T` and throws on its own, so those
wrappers get deleted rather than migrated.

---

## 4. Strategy

**A single atomic flip, with as much de-risking as possible landed first on Solid 1.**

Staging the flip package-by-package is not available to us. `@shared/rp-auth`
feeds three Cire apps *and* `pulse/web`; `@osn/ui` feeds `osn/social` *and*
`pulse/web`. The moment a shared library moves to Solid 2, every consumer must
move with it, and holding two Solid versions in one Bun workspace produces
duplicate-instance hydration bugs. Per the repo's pre-launch rule we do not build
compat shims to paper over that.

So: split the work in two. Everything that is *forward-compatible* — works under
Solid 1 and is required for Solid 2 — lands as ordinary PRs first. What is left
is one flip.

---

## 5. Phase A — de-risk on Solid 1 (independent PRs, any order)

Each of these ships and merges on its own, keeps the app on Solid 1, and shrinks
the flip.

**A1. Replace `solid-toast` with an in-house toast in `@osn/ui`.**
Export `toast` with the same surface (`.success`, `.error`, `.custom`, `dismiss`)
plus a `<Toaster>`. Rewrite the ~87 import lines to point at `@osn/ui`. Drop the
dependency from six packages. Kills a dead dependency whether or not we ever do
Solid 2.

**A2. Replace `@thisbeyond/solid-dnd` in `cire/host/src/components/EventsEditor.tsx`.**
One component, one dependency, three years unmaintained.

**A3. Drop SolidStart from `pulse/web`.**
Replace `solidStart({ssr:false})` with the plain-Vite + `@solidjs/router` setup
`osn/social` already uses: hand-write the route table in place of `FileRoutes`,
replace `entry-client.tsx`/`entry-server.tsx` with a single `render()` mount,
drop `@solidjs/start` and `nitro`. Removes the hardest upstream blocker and
makes `pulse/web` and `osn/social` structurally identical, which is worth having
regardless.

**A4. Fork `@astrojs/solid-js` into `shared/astro-solid`.**
Copy the six source files, keep them on `vite-plugin-solid@2` and Solid 1, point
the six Astro apps at the workspace package, confirm every app still builds and
hydrates. This proves the fork works *before* it also has to absorb Solid 2's
import moves. Do not skip the "still on Solid 1" step — it separates fork bugs
from migration bugs.

**A5. Delete the `batch()` calls in `cire/invites` (7).**
Solid 1 keeps working; 2.0 makes them meaningless.

**A6. Delete the `useX`-with-throw context wrappers' *need*.**
Leave the wrappers for now, but stop adding new ones.

**A7. Audit ref callbacks for `onCleanup`.**
Produce a list of every `ref={…}` that registers cleanup inside the callback.
This is the silent-breakage class; having the list before the flip is worth more
than fixing them early.

Nothing in Phase A depends on Solid 2 landing. If the flip is postponed
indefinitely, A1–A4 are still improvements.

## 6. Phase B — the flip (one integration branch)

Branch `feat/solid-2`, with sub-PRs merged into it, one merge to `main` at the end.

**B0. Pin versions at the root.**
`solid-js@2.0.0-rc.0`, `@solidjs/web@2.0.0-rc.0`, `@solidjs/router@2.0.0-next.16`,
`@solidjs/meta@1.0.0-next.2`, `vite-plugin-solid@3.0.0-next.27`,
`@solidjs/testing-library@1.0.0-beta.2`, `@kobalte/core@2.0.0-alpha.0`.
Exact pins, no carets — these are pre-releases and will move under us.
Add `resolve.dedupe: ["solid-js", "@solidjs/web", "@solidjs/router"]` to every
Vite config; duplicate Solid instances are the reported failure mode.
Set `jsxImportSource: "@solidjs/web"` in `shared/typescript-config/solid.json`
and the six app tsconfigs.

**B1. `shared/astro-solid`** — retarget the fork at Solid 2: `Suspense`→`Loading`,
store imports into `solid-js`, renderer imports into `@solidjs/web`,
`vite-plugin-solid@2` → `@3`. Verify `renderToStringAsync` and the `renderId`
option still exist under the 2.0 renderer; if they moved, the sync/async render
strategy in `server.ts` needs reworking. **Highest-uncertainty item in the plan.**

**B2. Leaf libraries — `@osn/client`, `@shared/rp-auth`.**
Small (43 and 4 files), no workspace Solid deps, and between them hold 6 of the
context providers and 6 `createResource` calls. Do these first: they are the
smallest possible end-to-end proof that the new versions work.

**B3. `@osn/ui`.** Kobalte 2 alpha lands here, plus 48 `splitProps` rewrites and
8 `createResource`. Budget for Kobalte's own breaking changes — its 2.0 is an
alpha, not just a peer-dep bump.

**B4. Pilot app — `osn/social`.** Plain Vite SPA, 51 files, router usage limited
to `A`/`useNavigate`/`useParams`/`useLocation`/`useSearchParams` (no `cache`,
no `createAsync`, no `load`), so router 2 is a low-risk bump. Carries the full
shape of the migration — 15 `createResource`, 20 providers, 10 `Suspense` — at
the smallest size. **Everything learned here should be written down before B5.**

**B5. `pulse/web`.** Post-A3 it is the same shape as `osn/social`, but 35
`createResource` and 22 `classList` make it the heaviest single app.

**B6. Astro apps, smallest first** — `osn/landing` (17), `pulse/landing` (17),
`cire/landing` (34), then `cire/vendor` (53), `cire/invites` (129), `cire/host` (191).
The three landing apps have no workspace Solid deps and almost no state, so they
are the real test of B1's fork. `cire/host` is last: it is the largest package,
the only Kobalte + drag-and-drop consumer, and holds the `<Index>` and `unwrap`
sites.

**B7. Test sweep.** 155 files import `@solidjs/testing-library`. Expect to insert
`flush()` after setter calls throughout, and expect the beta's own rough edges —
the reported workaround is a Vite alias plus `deps.inline` for the testing library.

## 7. Phase C — after the flip

- Drop the pinned pre-release versions to carets once each package hits stable.
- `@solidjs/start` may ship a Solid 2 line later; `pulse/web` does not need it
  and should not go back.
- Watch for an official `@astrojs/solid-js` with Solid 2 support and retire
  `shared/astro-solid` if it arrives. Until then the fork is ours to maintain.
- Adopt the 2.0-only APIs where they pay: `createProjection`, `createOptimistic`
  for the RSVP and claim flows, `Repeat` for skeletons, `Reveal` for the invite
  page's staged reveal.

---

## 8. Risks, in the order they will bite

1. **The Astro fork (B1) is the plan's keystone.** Six of eleven packages depend
   on it, and it is the only piece where we are writing framework glue rather
   than following a migration guide. If SSR rendering under Solid 2 does not
   line up with what Astro's renderer contract expects, six packages stall.
   Phase A4 exists to find this out early.
2. **Everything is pre-release.** `solid-js` is at RC, but the router, meta,
   Vite plugin, testing library and Kobalte are next/beta/alpha. Kobalte 2 alpha
   is six days old. Pin exactly and expect churn.
3. **Deferred batching breaks tests silently.** A test that sets a signal and
   asserts on the next line now reads a stale value. 155 test files.
4. **Unowned ref callbacks leak listeners without failing.** No test catches this.
   Hence the A7 audit.
5. **`createResource` is 106 sites and not centralised.** This is not a rename;
   components change shape around `Loading` boundaries.
6. **Kobalte 2 is a second migration riding along.** Its API changes are separate
   from Solid's and are not covered by the Solid migration guide.

## 9. Sources

- [Solid 2.0 migration guide](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/MIGRATION.md)
- [Things Learned Migrating To Solid 2.0 — brenelz](https://www.brenelz.com/posts/migrating-to-solid-2/)
- [SolidJS 2.0 Beta: First-Class Async, Reworked Suspense and Deterministic Batching — InfoQ](https://www.infoq.com/news/2026/05/solidjs-2-async/)
- [`@astrojs/solid-js` integration source](https://github.com/withastro/astro/tree/main/packages/integrations/solid)
