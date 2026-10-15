/**
 * Mutation testing: `bun run test:mutation`, usually scoped with
 * `--mutate <file>`. See wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * `bun test` has no Stryker runner, so this uses the command runner, which
 * runs the whole command once per mutant.
 */

import { cireStryker } from "../../scripts/stryker-cire-options.mjs";

const { pkg, options } = cireStryker(import.meta.dirname);

export default {
  ...options,
  testRunner: "command",
  commandRunner: { command: `cd ${pkg} && bun test` },
};
