/**
 * Mutation testing: `bun run test:mutation`, usually scoped with
 * `--mutate <file>`. See wiki/conventions/testing-patterns.md §Mutation testing.
 */

import { cireStryker } from "../../scripts/stryker-cire-options.mjs";

const { pkg, options } = cireStryker(import.meta.dirname);

export default {
  ...options,
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: `${pkg}/stryker.vitest.config.ts`, related: false },
};
