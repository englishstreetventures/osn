# @cire/waves

Two waves that open the invite builder's preview below its wide breakpoint,
built side by side so the owner can choose between them in the real builder
(englishstreetventures/osn#2415, part of #1956). The builder picks one by
`?preview-wave=gilded|distortion`, Gilded by default; the one not chosen comes
out in a follow-up.

- **`@cire/waves/gilded`** — `GildedWave`, ours. A fixed frame handed over to
  or from the page through a same-document View Transition, its picture cut by
  a feathered circle on the wave's front, with a WebGL 2 canvas drawing the
  couple's gold over it: the band, a crest of light, the colour left on the
  frame's edges and the dust. It never pictures the page. Without WebGL 2 it
  runs the transition alone; without View Transitions, and under reduced
  motion, it fades on `--dur-slow`. Source: `src/gilded/`.
- **`@cire/waves/distortion`** — `DistortionWave`, a Solid port of the React
  wrapper of Jakub Antalik's Distortion Waves, round its framework-free core,
  vendored unedited in `vendor/` (MIT; `vendor/README.md` holds the pin, the
  check against upstream and the re-vendor recipe). Upstream's defaults stand:
  it pictures the element for its lens, takes the first picture at idle, and
  uses the type's own palette. Source: `src/distortion/`.

Gilded's maths follows Distortion Waves too (the anticipation, the eased
front, the rim that lingers on the edges), so its source names the MIT notice
in `vendor/LICENSE` as well. Our code is `UNLICENSED`, as `package.json` says;
the vendored core keeps its own licence beside it.

## Test hooks

In a development build only, `window.__cireWaves` holds `holdGilded(p)`,
`releaseGilded()` and `distortion()`: the E2E flow
(`tools/e2e/tests/flows/cire-invite-preview-wave.flow.ts`) holds the Gilded
wave at fixed points to screenshot it and reads the Distortion controller's
state. `tests/hooks.test.ts` builds the package for production and fails if
the hook is in the bundle.

## Tests

- `bun run test:browser` — both waves in Chromium, one test per way each can
  fail (`tests/*.browser.test.*`). Set `VITEST_BROWSER_EXECUTABLE_PATH` where
  the installed Chromium does not match the pinned Playwright.
- `bun run test:run` — the production-bundle check, in Node.
- `bun run test:mutation --changed` — Stryker on the `unit` project, which
  covers none of the waves' code: their survivors are killed by the browser
  tests and the E2E flow, named in the pull request
  (`wiki/conventions/testing-patterns.md` §What to do with a survivor).

`scripts/verify-vendored.sh cire/waves/vendor` checks the vendored tree; CI
runs it on every tree `scripts/vendored-trees.txt` lists.
