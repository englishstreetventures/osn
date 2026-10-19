/**
 * Mutation testing: `bun run test:mutation`, usually scoped with
 * `--changed`. See wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * The stack tests evaluate each stack through Alchemy with Bun's platform
 * layer and read SQLite through `bun:sqlite`, and Stryker's vitest runner
 * runs tests under Node. So this uses the command runner, which runs the
 * whole suite under Bun once per mutant; it takes a few seconds.
 *
 * The cross-stack test imports the musubi stack's declaration and seeds, so
 * the sandbox keeps `musubi/`.
 */

import { cireStryker } from "../../../tools/stryker/src/options.mjs";

const { pkg, options } = cireStryker(import.meta.dirname);

export default {
  ...options,
  ignorePatterns: options.ignorePatterns.filter((pattern) => pattern !== "musubi"),
  testRunner: "command",
  commandRunner: { command: `cd ${pkg} && bunx --bun vitest run` },
  // Each run starts Bun, Vitest and Alchemy and bundles cire-api; with one
  // run per core they starve each other past Stryker's default timeout,
  // which reports every mutant as timed out.
  concurrency: 4,
  timeoutMS: 60_000,
};
