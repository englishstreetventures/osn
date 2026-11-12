import { defineConfig } from "vitest/config";

/**
 * The test files that read files outside this package. They run as the
 * `repo` project (`test:repo`, which turbo reruns when those files change).
 * tests/package.test.ts fails unless this list is exactly the test files
 * whose paths climb above the package.
 */
export const READS_REPO = [
  "tests/accounts.test.ts",
  "tests/assets-content-type.test.ts",
  "tests/package.test.ts",
  "tests/secrets/environments.test.ts",
  "tests/secrets/inventory.test.ts",
  "tests/workflow-hosts.test.ts",
  "tests/workflow-secrets.test.ts",
  "tests/wrangler-routes.test.ts",
];

/**
 * The test files that run one of this package's Alchemy scripts, which run
 * the whole installed Alchemy tree. They run as the `alchemy` project
 * (`test:alchemy`, which turbo reruns when the lockfile, the root manifest,
 * the patches, the Bun version or this package changes).
 * tests/package.test.ts fails unless this list is exactly those files.
 */
export const RUNS_ALCHEMY = ["tests/state-cli.test.ts"];

/**
 * Every other file runs as the `package` project (`test`), cached on the
 * package's own files. A file is in exactly one of the three.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Loading Alchemy and the tests that spawn `bun` take about a second
    // alone, and several times that under `bun run test`, which runs every
    // workspace's tests at once.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "package",
          include: ["tests/**/*.test.ts"],
          exclude: [...READS_REPO, ...RUNS_ALCHEMY],
        },
      },
      { extends: true, test: { name: "repo", include: READS_REPO } },
      { extends: true, test: { name: "alchemy", include: RUNS_ALCHEMY } },
    ],
  },
});
