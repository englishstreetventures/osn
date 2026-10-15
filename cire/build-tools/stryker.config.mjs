/**
 * Mutation testing: `bun run test:mutation`, usually scoped with
 * `--mutate <file>`. See wiki/conventions/testing-patterns.md §Mutation testing.
 *
 * `scripts/stryker-cire.ts` runs Stryker from the repo root with this file, so
 * the sandbox is a copy of the whole repository and every path below is
 * root-relative.
 */

import { relative } from "node:path";

const pkg = relative(process.cwd(), import.meta.dirname);

export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: `${pkg}/stryker.vitest.config.ts`, related: false },
  mutate: [`${pkg}/src/**/*.{ts,tsx}`, `!${pkg}/src/**/*.d.ts`],
  tempDirName: ".stryker-tmp-cire-build-tools",
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
