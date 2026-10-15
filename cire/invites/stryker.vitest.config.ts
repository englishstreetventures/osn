/**
 * The Vitest config Stryker runs. Stryker's Vitest runner starts every project
 * in the config it is given, and the `browser` project needs a Chromium per
 * mutant, so this drops it and keeps the fast tier. Mutants only the browser
 * tier can kill report as survivors here.
 */

import { defineConfig } from "vitest/config";

import base from "./vitest.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test?.projects?.filter(
      (project) =>
        typeof project !== "object" || !("test" in project) || project.test?.name !== "browser",
    ),
  },
});
