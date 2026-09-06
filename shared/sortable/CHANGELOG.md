# @shared/sortable

## 0.1.3

### Patch Changes

- d96da64: Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges.

  `fast-uri` 3.1.5 → 3.1.7. Four high advisories against 3.1.5 landed on 2026-09-02 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — two SSRF, two host confusion) and the pre-push `bun audit` gate went red. Taking 3.1.6, which is what those four advisories name as fixed, would have left two more: 3.1.7 also fixes GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port in `serialize()`) and GHSA-58mr-gqgx-xq4g (host confusion via unbalanced IP-literal brackets), neither of which is in the public advisory database yet, so no audit tool reports them. Reachability is the Astro language server only — `ajv` appears once in the lockfile, under `@astrojs/check`, and no deployed Worker or shipped bundle contains it. `smol-toml` 1.6.1 → 1.8.0 is the same shape: 1.7.1 carries the fix for GHSA-7w5x-hrqm-74c2, also absent from the database.

  The rest is lockfile lag. The dependency sweep in this stack raised every declared range, but `bun.lock` stayed behind versions those ranges already admitted: `esbuild` 0.28.2, `postcss` 8.5.26, `picomatch` 4.0.7, `sharp` 0.35.4 (libvips 1.3.3), `js-yaml` 4.3.2, `ws` 8.21.3, `devalue` 5.9.2, `happy-dom` 20.12.2, `@cloudflare/workers-types` 5.20260903.1. Two are worth knowing about rather than just taking: `ws` 8.21.1 **lowers the `maxBufferedChunks` and `maxFragments` defaults** and counts empty fragments toward the limit, which is a behaviour change inside a patch and touches Zap's WebSocket surface; `picomatch` 4.0.5–4.0.7 are all matching-semantics fixes, so glob-driven config can shift.

  `astro` 7.2.9 → 7.2.10 is the one with deployed consequences. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. It is pinned to 7.2.10 rather than left to float: 7.3.0 and 7.3.1 clear the three-day soak but not the fourteen-day rule for a minor, so they wait.

  Two overrides were correcting themselves in the wrong direction and are fixed here. `undici` was pinned `^7.29.0` while `jsdom` 30 declares `undici ^8.9.0` and `unifont` 0.7.5 declares `^8.0.0` — a floor being used as a ceiling, holding both consumers a whole major below what they were written for and cutting the tree off from undici 8 security fixes. Raised to `^8.9.0` (resolves 8.10.1). Because top-level `miniflare` 4 pins undici at exactly 7.28.0 and the wrangler-nested miniflare 5 alpha pins 7.29.0, this was verified rather than assumed: type check, the full test suite, the Miniflare D1 tier, all four Worker builds, and a real `wrangler dev --local` boot of `osn-api` on workerd, which serves 200 on `/health`, `/.well-known/jwks.json` and `/` with no errors. `postcss` and `picomatch` were likewise below what `vite` 8.2.2 asks for (`^8.5.26` and `^4.0.5`), a floor gap opened by raising vite earlier in this stack.

  Also: the `protobufjs` override matched nothing in the lockfile and is removed, and `bunfig.toml`'s note on the removed `fast-uri` soak exclusion claimed the package "parses URIs on the request path via ajv", which is not true of this tree and would have mispriced exactly the decision this changeset had to make.

  One source change, in `cire/api/tests/index.test.ts`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` a required member of `Span`, so the test's `StubSpan` gains it, typed off the interface rather than restated so the next daily types release cannot drift it.

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

## 0.1.2

### Patch Changes

- 853367f: Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Every package listed here sits on that chain. Build output is byte-identical.

## 0.1.1

### Patch Changes

- 70ac0f3: Drop the unused `@testing-library/jest-dom` devDependency from every package that declared it but imports no matcher, now that `vite-plugin-solid` no longer injects its setup file. Guard the suppression markers in CI, and list the marker file under turbo's `globalDependencies` so an edit to it can no longer be served from cache.

## 0.1.0

### Minor Changes

- 46204b2: Add `@shared/sortable` — internal drag-to-reorder for SolidJS, to replace
  `@thisbeyond/solid-dnd` (last released November 2023). No consumer uses it yet;
  the migration follows.

  The API mirrors what it replaces — `DragDropProvider`, `DragDropSensors`,
  `SortableProvider`, `createSortable`, `closestCenter`, `maybeTransformStyle`,
  `useDragDropContext` — so adopting it is an import swap. One difference:
  `transform`, `isActiveDraggable` and `active` are accessors rather than store
  properties, so call them.

  Two things the replaced library could not do:

  - **`createSortableList` owns the keyboard and screen-reader path.** solid-dnd
    shipped a pointer sensor and nothing else, so every list that wanted dragging
    had to hand-write ~120 lines of it — which is why three lists in the organiser
    portal never adopted drag and said so in code. The package now carries all five
    obligations, with tests: a real `<button>` grip owning the arrows with
    `preventDefault` before the bounds check, `sr-only` move buttons for browse
    mode, explicit focus restore after a keyboard move, a live region that clears
    before it sets, and auto-repeat ignored. Hint ids are generated per list, so
    several lists can share a page.
  - **Multi-container.** Items register with the `SortableProvider` they sit under,
    and collision detection never crosses a group. Deliberately not
    cross-container: moving an item between lists is a re-bucketing, not a
    re-order.

  Geometry is measured **once, at drag start**. Layout cannot change during a drag
  except for the transforms this package writes, and those are exactly what must be
  excluded — a live read let the dragged row's own offset corrupt the stride, and
  let the detector see displaced rows in the slots they were moving _to_. It also
  keeps the cost flat: at 500 rows a per-event sweep is ~30–60k
  `getBoundingClientRect()` per second, each behind a forced style flush.

  The gesture owns its listeners: pointer capture so a release outside the window
  still ends the drag, a `pointerId` guard so a second touch cannot drive another
  finger's gesture, and an `onCleanup` so an unmount mid-drag tears them down.
