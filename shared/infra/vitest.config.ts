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
  "tests/package.test.ts",
  "tests/secrets/inventory.test.ts",
  "tests/workflow-hosts.test.ts",
  "tests/workflow-secrets.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "package", include: ["tests/**/*.test.ts"], exclude: READS_REPO },
      },
      { extends: true, test: { name: "repo", include: READS_REPO } },
    ],
  },
});
