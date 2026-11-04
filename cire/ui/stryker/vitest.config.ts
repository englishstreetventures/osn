/**
 * The Vitest config `stryker/config.mjs` runs. Stryker starts Vitest from the
 * repo root, so `root` pins it back to this package, where the `include` and
 * `setupFiles` paths of `vitest.config.ts` are written from.
 *
 * Stryker's Vitest runner also starts every project in the config, and the
 * `browser` project needs a Chromium per mutant, so this drops it and keeps
 * the fast tier. A mutant only the browser tier can kill reports as a survivor.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import base from "../vitest.config.ts";

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    ...base.test,
    projects: base.test?.projects?.filter(
      (project) =>
        typeof project !== "object" || !("test" in project) || project.test?.name !== "browser",
    ),
  },
});
