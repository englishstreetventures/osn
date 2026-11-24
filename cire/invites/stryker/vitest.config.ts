/**
 * The Vitest config `stryker/config.mjs` runs. Stryker starts Vitest from the
 * repo root, so `root` pins it back to this package, where the paths of
 * its `vitest.config.ts` are written from.
 *
 * Stryker's Vitest runner also starts every project in the config, and the
 * `browser` project needs a Chromium per mutant, so this drops it and keeps
 * the fast tier. A mutant only the browser tier can kill reports as a survivor.
 *
 * `server.fs.strict` is off because the sandbox is a copy of the repository
 * whose `node_modules` links still point at the original: a test that imports
 * a workspace file with `?raw` (`tests/pages/legal-pages.test.ts`, the shared
 * privacy notice) resolves outside the sandbox, which Vite otherwise refuses
 * with "Denied ID" and fails the dry run. Nothing here is served.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import base from "../vitest.config.ts";

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { fs: { strict: false } },
  test: {
    ...base.test,
    projects: base.test?.projects?.filter(
      (project) =>
        typeof project !== "object" || !("test" in project) || project.test?.name !== "browser",
    ),
  },
});
