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
  // `related: true` picks tests by import graph and misses the ones that reach
  // a module indirectly: on `@cire/host`'s `src/lib/haptics.ts` it killed 6
  // mutants where the full suite kills 20.
  vitest: { configFile: `${pkg}/stryker.vitest.config.ts`, related: false },
};
