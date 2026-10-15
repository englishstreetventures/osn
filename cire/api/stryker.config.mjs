/**
 * Mutation testing: `bun run test:mutation`, usually scoped with
 * `--mutate <file>`. See wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * `bun test` has no Stryker runner, so this uses the command runner, which runs
 * the whole command once per mutant. The full suite takes over a minute and
 * boots workerd, so `STRYKER_TESTS` must name the test files that cover the
 * code being mutated, relative to this package:
 *
 *   STRYKER_TESTS=tests/lib/money.test.ts bun run test:mutation --mutate src/lib/money.ts
 */

import { cireStryker } from "../../scripts/stryker-cire-options.mjs";

const { pkg, options } = cireStryker(import.meta.dirname);

const tests = process.env.STRYKER_TESTS;
if (!tests) {
  throw new Error(
    "Set STRYKER_TESTS to the test files covering the mutated code (cire/api/stryker.config.mjs)",
  );
}

export default {
  ...options,
  testRunner: "command",
  commandRunner: {
    command: `cd ${pkg} && bun test --preload ./tests/test-helpers/metrics-harness.ts ${tests}`,
  },
};
