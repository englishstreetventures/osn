/**
 * The Vitest config `stryker/config.mjs` runs. Stryker starts Vitest from the
 * repo root, so `root` pins it back to this package, where the `include` and
 * `setupFiles` paths of `vitest.config.ts` are written from.
 *
 * Unlike the other cire packages, this one keeps the `browser` project: both
 * waves are WebGL 2, View Transitions and layout, which only Chromium has, so
 * the browser tests are the only tests that run their code. Dropping them, as
 * `cire/ui` does for speed, would leave every mutant uncovered. A run is
 * slower for it (a Chromium page per test), which `--changed` keeps to the
 * branch's lines. Set `VITEST_BROWSER_EXECUTABLE_PATH` as for
 * `bun run test:browser` where the installed Chromium does not match the
 * pinned Playwright.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import base from "../vitest.config.ts";

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("..", import.meta.url)),
});
