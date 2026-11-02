import { defineConfig } from "vitest/config";

/**
 * The test files that read files outside this package. They run as the
 * `repo` project (`test:repo`, which turbo reruns when those files change);
 * every other file runs as the `package` project (`test`), cached on the
 * package's own files. A file is in exactly one of the two, and
 * tests/package.test.ts fails unless this list is exactly the test files whose
 * paths climb above the package.
 */
export const READS_REPO = [
  "tests/accounts.test.ts",
  "tests/assets-content-type.test.ts",
  "tests/package.test.ts",
  "tests/secrets/environments.test.ts",
  "tests/secrets/inventory.test.ts",
  "tests/workflow-hosts.test.ts",
  "tests/workflow-secrets.test.ts",
];

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
        test: { name: "package", include: ["tests/**/*.test.ts"], exclude: READS_REPO },
      },
      { extends: true, test: { name: "repo", include: READS_REPO } },
    ],
  },
});
