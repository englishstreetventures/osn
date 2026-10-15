/**
 * Mutation testing — `bun run test:mutation`. See
 * wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * `bun test` has no Stryker runner, so this uses the command runner, which
 * runs the whole suite once per mutant.
 *
 * @type {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export default {
  testRunner: "command",
  commandRunner: { command: "bun test" },
  inPlace: true,
  mutate: ["src/**/*.ts"],
  reporters: ["clear-text", "progress", "html"],
};
