import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * The test files that read files outside this package: cire-api's tiers and
 * slug rule, the organiser portal's name cap, the guest site's brand tokens.
 * They run as the `repo` project (`test:repo`, which turbo reruns when those
 * files change, `turbo.json` here); every other file runs as the `package`
 * project (`test`), cached on the package's own files.
 */
export const READS_REPO = [
  "tests/lib/plans.test.ts",
  "tests/lib/slug-preview.test.ts",
  "tests/styles/design-token-contract.test.ts",
];

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    // happy-dom, not jsdom, and it is not a preference: jsdom implements no
    // part of `<dialog>` — `showModal` is `undefined` there — so the demo
    // sheet, which is `@shared/ui`'s `Modal`, cannot open at all. happy-dom has
    // it, and it is what every other component-testing package here uses.
    environment: "happy-dom",
    transformMode: { web: [/\.[jt]sx?$/] },
    passWithNoTests: true,
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
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
