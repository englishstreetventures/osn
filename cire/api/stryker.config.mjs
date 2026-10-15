/**
 * Mutation testing — `bun run test:mutation`. See
 * wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * `bun test` has no Stryker runner, so this uses the command runner, which runs
 * the whole command once per mutant. The full suite takes over a minute, so
 * `STRYKER_TESTS` names the test files that cover the code being mutated:
 *
 *   STRYKER_TESTS=tests/lib/money.test.ts bun run test:mutation --mutate src/lib/money.ts
 *
 * @type {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export default {
  testRunner: "command",
  commandRunner: {
    command: `bun test --preload ./tests/test-helpers/metrics-harness.ts ${process.env.STRYKER_TESTS ?? ""}`,
  },
  inPlace: true,
  mutate: ["src/**/*.ts"],
  reporters: ["clear-text", "progress", "html"],
};
