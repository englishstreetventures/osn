# @tools/lab

## 0.1.8

### Patch Changes

- 853367f: Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Every package listed here sits on that chain. Build output is byte-identical.
- Updated dependencies [853367f]
  - @osn/ui@1.10.4

## 0.1.7

### Patch Changes

- @osn/ui@1.10.3

## 0.1.6

### Patch Changes

- db8e5f9: Gate every component-lab story in CI. `tools/lab/tests/stories.test.tsx` imports
  every file the registry globs match and renders each story that can run
  headless, so a bench that has silently stopped mounting fails the build instead
  of appearing as an error row in the sidebar that nobody opens. A story that
  needs a real browser opts out with `headless: false` in its `meta`; both
  three.js stories do.

  Also scope the Turborepo `test`, `test:d1` and `test:browser` caches with a
  subtractive `inputs` list, so a markdown-only edit no longer busts a package's
  test cache.

## 0.1.5

### Patch Changes

- Updated dependencies [70ac0f3]
  - @osn/ui@1.10.2

## 0.1.4

### Patch Changes

- @osn/ui@1.10.1

## 0.1.3

### Patch Changes

- Updated dependencies [5159096]
  - @osn/ui@1.10.0

## 0.1.2

### Patch Changes

- @osn/ui@1.9.1

## 0.1.1

### Patch Changes

- 1648d97: Bench `@shared/toast` and `@shared/sortable` in the component lab, and stop the
  lab swallowing a story's arrow keys.

  Drag feel, the shift/settle animation, grip hover/focus and painted toast colour
  are invisible to every test tier we have — happy-dom computes no layout, so a
  drag test can only assert numbers against stubbed rects. `bun run dev:lab` now
  carries **shared/sortable** (drag feel, multi-container isolation, the keyboard
  path) and **shared/toast** (tones, positions, stacking, actions and promises,
  overflow). Both are co-located `*.story.tsx` with no lab imports, so they stay
  ordinary files in their own package.

  The lab's arrow-key story navigation now bails on `event.defaultPrevented`, which
  `@shared/sortable`'s grip already sets. Without that the lab stepped to the next
  story on every attempted row move, which made the keyboard half of that package —
  the half with no other way to be exercised by hand — untestable there. Any story
  that owns the arrows gets the same protection.

- Updated dependencies [3dfde85]
  - @osn/ui@1.9.0

## 0.1.0

### Minor Changes

- 7a75d6c: Run the component lab behind portless like every other dev server: `bun run dev:lab` now answers on `https://lab.localhost`, and a branch worktree gets its own copy of it. Also puts `PORTLESS` in turbo's `globalPassThroughEnv` — strict env mode was stripping it, so the documented `PORTLESS=0` fallback never reached any app.
- 7a75d6c: Add the component lab: a Vite + Solid scratchpad on port 4400 that finds every `*.story.tsx` in the monorepo, renders it with live args, and ships three.js / canvas helpers for spiking WebGL and HTML-in-canvas work. Comes with a catalogue of every `@osn/ui` component and the Pulse icon set. `bun run dev:lab`.
