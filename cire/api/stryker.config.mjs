/**
 * Mutation testing: `bun run test:mutation`, usually scoped with
 * `--mutate <file>`. See wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * `scripts/stryker-cire.ts` runs Stryker from the repo root with this file, so
 * the sandbox is a copy of the whole repository and every path below is
 * root-relative.
 *
 * `bun test` has no Stryker runner, so this uses the command runner, which runs
 * the whole command once per mutant. The full suite takes over a minute and
 * boots workerd, so `STRYKER_TESTS` must name the test files that cover the
 * code being mutated, relative to this package:
 *
 *   STRYKER_TESTS=tests/lib/money.test.ts bun run test:mutation --mutate src/lib/money.ts
 */

import { relative } from "node:path";

const pkg = relative(process.cwd(), import.meta.dirname);

const tests = process.env.STRYKER_TESTS;
if (!tests) {
  throw new Error(
    "Set STRYKER_TESTS to the test files covering the mutated code (cire/api/stryker.config.mjs)",
  );
}

export default {
  testRunner: "command",
  commandRunner: {
    command: `cd ${pkg} && bun test --preload ./tests/test-helpers/metrics-harness.ts ${tests}`,
  },
  mutate: [`${pkg}/src/**/*.{ts,tsx}`, `!${pkg}/src/**/*.d.ts`],
  tempDirName: ".stryker-tmp-cire-api",
  ignorePatterns: [
    ".claude",
    "wiki",
    ".stryker-tmp-*",
    "**/dist",
    "**/.astro",
    "**/.turbo",
    "**/.wrangler",
    "**/reports",
  ],
  cleanTempDir: "always",
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: `${pkg}/reports/mutation/mutation.html` },
};
