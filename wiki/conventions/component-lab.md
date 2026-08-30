---
title: Component Lab
description: The in-repo Storybook replacement for prototyping components, three.js scenes and canvas work
tags: [convention, frontend, tooling]
related:
  - "[[component-library]]"
  - "[[frontend-patterns]]"
  - "[[commands]]"
  - "[[devloop-urls]]"
last-reviewed: 2026-08-28
---

# Component Lab

`@tools/lab` — a bench for building a component before it has anywhere to live.
Storybook's shape (sidebar of stories, live preview, args panel) in roughly 600
lines, on the stack the repo already runs.

```bash
bun run dev:lab          # https://lab.localhost
```

The lab is in the portless map like any other dev server, so it answers on a
name and a branch worktree gets its own copy of it — see [[devloop-urls]]. Its
`DEV_ENV` entry is empty: it renders components, not screens, so it has no
sibling to address.

Nothing here ships. Full usage is in `tools/lab/README.md`; this page records
the decisions behind it.

## The catalogue

`osn/ui` → **Everything** is every component `@osn/ui` exports on one page, each
with its import path — the "what do we already have" view. Per-component groups
(`osn/ui/Button`, `osn/ui/display`, `osn/ui/forms`, `osn/ui/overlays`) carry the
variants and states.

`shared/toast` and `shared/sortable` are benches rather than catalogues: they
exist for the behaviour no test tier can reach. Their unit suites assert the
toast queue and DOM contract, and the sortable's drop semantics against stubbed
rects — happy-dom computes no layout, so a drag test can only check numbers.
What is left over is exactly what a bench is for: whether a drag tracks the
pointer, whether the rows between it and the target shift aside to preview the
drop, whether the grip is findable on hover and visible on focus, and whether a
toast reads on the surface it lands on. The **light · dark** toggle is part of
the toast bench, not chrome around it — the lab borrows `@osn/social`'s
stylesheet, which is what maps the shadcn ramp onto the `--toast-*` contract, so
the toggle re-themes toasts exactly as the app does. See [[toast]] and
[[drag-and-drop]].

> [!note]
> The shift-aside is the case in point. It shipped broken: `transform` returned
> `null` for every non-dragged row, so the "rows shifting aside" styling
> animated nothing while every drop-semantics test stayed green. A bench shows
> that in a second; no assertion we had could.

App-level components — `pulse/web/src/components`, `cire/invites`,
`osn/social` — are **not** catalogued. They read from an API client, a router
and an auth session; standing those up in a story means fixtures the repo
deliberately keeps out of app source — see [[component-library]]. The path is
open where a component needs no such context: `pulse/Icon` is catalogued from
a story sitting in `pulse/web/src/components/Icon.story.tsx`, which imports
nothing from the lab and so stays an ordinary file in its own package. The two
`shared/*` benches are the same shape — bare component exports, no lab imports,
typechecked and linted in their own package like any other file.

## Why not Storybook

Storybook's Solid support (`storybook-solidjs-vite`) is community-maintained and
trails the Vite major line, and this repo is on Vite 8 with Tailwind v4. Adopting
it means a second build config, a second set of version constraints on every
Vite/Tailwind bump, and a `.storybook/` directory that has to be taught about the
token stylesheet anyway.

The parts actually wanted — discovery, a preview, live args, backdrops, a
viewport — are a few hundred lines against `import.meta.glob` and a Solid store.
The parts not wanted (a docs site, an addon API, a test runner, a static build
for publishing) are most of what Storybook is. Revisit if the lab starts growing
addons, or if the design system needs published docs for people outside the repo.

## Shape

| Piece | File | Notes |
| --- | --- | --- |
| Discovery | `src/lab/registry.ts` | `import.meta.glob` over `*.story.tsx`. Globs are literal — a new workspace root means a new line. |
| Story contract | `src/lab/types.ts` | Args are `string \| number \| boolean` — exactly what a control can edit. |
| Args panel | `src/lab/controls.tsx` | The panel itself. |
| Control inference | `src/lab/infer-control.ts` | Editor inferred from the initial value; `controls` overrides. Kept JSX-free so it can be tested. |
| three / canvas | `src/lab/three.tsx` | `ThreeCanvas`, `Canvas2D`, `htmlToCanvas`, `htmlToTexture`, CSS3D layer. |
| Shell | `src/Lab.tsx` | Sidebar, backdrops, viewports, theme, remount, `?bare`. |

Stories live either in `tools/lab/src/stories/` (spikes) or next to a real
component under any workspace's `src/` (permanent bench). Both are found.

## Decisions worth keeping

**The lab imports `osn/social/src/App.css` rather than copying tokens.** That
file is the source of truth for `--background`, the `.dark` block and the `base:`
variant every `@osn/ui` class is written against. A second copy drifts. The cost
is that the OSN look is the lab's default; a story with its own design language
imports its own CSS.

**No iframe.** Stories render in the same document as the chrome. Hot reload
stays instant and the code stays small; the trade is isolation — a story that
sets global CSS affects the chrome, and Dialog, DropdownMenu and Popover content
portals into `document.body`, so an open one covers the whole lab window.
`?bare` is the escape hatch, and is also what a screenshot tool should be
pointed at; `?theme=dark` forces a theme, since a screenshot tool cannot click
the toggle.

**Solid is deduped in the lab's Vite config.** Bun installs `solid-js` into each
workspace's own `node_modules` rather than hoisting it, so a story imported from
`pulse/web` resolves a second copy of the runtime. Two Solid instances do not
share a reactive graph — context reads come back undefined and effects silently
never fire. `resolve.dedupe` pins every import to one copy. Any new cross-package
import into the lab depends on this.

**Every export except `meta` is a story.** That is what makes
`export const Thing = () => <div />` work with no config. It also means an
exported helper shows up in the sidebar — keep helpers unexported.

**Stories are not tests and carry no gate.** Nothing in CI renders a story.
`check` typechecks the lab, `lint` and `fmt:check` cover it. A component whose
behaviour matters still needs a real test — see [[testing-patterns]].

The `test` script that does exist covers two pure helpers, `titleFromPath` and
`inferControl`, because both fail quietly: a wrong title still renders a row, a
wrong control still accepts input. Its config leaves out `vite-plugin-solid`,
which every other Solid package here uses. The plugin adds a
`@testing-library/jest-dom` setup file to any test run and the run dies without
that dependency, which a tool testing two pure functions should not carry. Every
other Solid package suppresses that injection with a marker in `setupFiles`
instead — see [[testing-patterns]] — but a lab that imports no `.tsx` file has
nothing to gain from the plugin either way. The price is that no test here can
import a `.tsx` file, and it is why `inferControl` sits in `infer-control.ts`
rather than beside the panel it feeds.

## HTML in canvas

Three routes, demonstrated in `src/stories/html-in-canvas.story.tsx`:

- `htmlToCanvas` — DOM-authored artwork rasterised for canvas compositing.
- `htmlToTexture` — the same raster as a `CanvasTexture` in a 3D scene.
- `css3d` + `CSS3DObject` — live, clickable DOM transformed by the scene camera.
  Real hit-testing, but it composites *over* the WebGL layer: geometry cannot
  occlude it and it takes no lighting.

The first two go through an SVG `foreignObject`, which loads nothing external
(no web fonts, no remote images) and parses its markup as XML (every tag closed).
Both limits belong to the technique, not the helper.

## Gates

`tools/lab` is a workspace (`tools/lab` in the root `workspaces` array, not
`tools/*` — `tools/oxlint` holds vendored plugin source and no package.json).
`scripts/validate-changesets.sh` scans `tools/` alongside the product directories
so a changeset naming `@tools/lab` validates; `fmt` and `fmt:check` list
`tools/lab` explicitly, so the vendored `tools/oxlint/anti-slop` is never
reformatted.
