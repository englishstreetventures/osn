/**
 * Mutation testing — `bun run test:mutation`. See
 * wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * @type {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: "stryker.vitest.config.ts", related: false },
  inPlace: true,
  mutate: ["src/**/*.{ts,tsx}", "!src/**/*.d.ts"],
  reporters: ["clear-text", "progress", "html"],
};
