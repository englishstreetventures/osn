import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * The test files that read files outside this package: the organisations
 * client's contract with `shared/openapi/osn.json`, and the token grant's
 * with that spec and with osn-api's grant-failure text. They run as the `repo`
 * project (`test:repo`, which turbo reruns when those files change,
 * `turbo.json` here); every other file runs as the `package` project
 * (`test`), cached on the package's own files.
 */
export const READS_REPO = [
  "tests/organisations-contract.test.ts",
  "tests/token-grant-contract.test.ts",
];

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
    // `include` lives in each project: vitest joins a root `include` onto every
    // project's, which would put the whole suite in `repo` as well.
    projects: [
      {
        extends: true,
        test: {
          name: "package",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: READS_REPO,
        },
      },
      { extends: true, test: { name: "repo", include: READS_REPO } },
    ],
  },
});
