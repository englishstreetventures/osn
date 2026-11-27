import { defineConfig } from "vitest/config";

/**
 * The test files that read files outside this package: the rows-affected
 * guard, which scans the Worker source trees. They run as the `repo` project
 * (`test:repo`, which turbo reruns when those trees change, `turbo.json`
 * here); every other file runs as the `package` project (`test`), cached on
 * the package's own files.
 */
export const READS_REPO = ["tests/no-raw-rows-affected.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    // `include` lives in each project: vitest joins a root `include` onto every
    // project's, which would put the whole suite in `repo` as well.
    projects: [
      {
        extends: true,
        test: { name: "package", include: ["tests/**/*.test.ts"], exclude: READS_REPO },
      },
      { extends: true, test: { name: "repo", include: READS_REPO } },
    ],
  },
});
