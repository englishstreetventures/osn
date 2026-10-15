/**
 * The Stryker options every cire package's `stryker.config.mjs` shares. Each config
 * spreads `options` and adds its own runner.
 *
 * `scripts/stryker-cire.ts` runs Stryker from the repo root, so the sandbox is
 * a copy of the whole repository and every path here is root-relative.
 * `ignorePatterns` is the only control over what that copy holds: Stryker does
 * not read `.gitignore`, so local secret files are listed here, and nothing a
 * cire test reads may be.
 */

import { basename, relative } from "node:path";

/** @param {string} configDir the package directory, `import.meta.dirname` of its config */
export function cireStryker(configDir) {
  const pkg = relative(process.cwd(), configDir);
  return {
    pkg,
    options: {
      // Setting `mutate` replaces Stryker's default exclusion of test files.
      mutate: [
        `${pkg}/src/**/*.{ts,tsx}`,
        `!${pkg}/src/**/*.d.ts`,
        `!${pkg}/src/**/*.{test,spec}.{ts,tsx}`,
      ],
      tempDirName: `.stryker-tmp-cire-${basename(configDir)}`,
      cleanTempDir: "always",
      ignorePatterns: [
        ".claude",
        "wiki",
        ".stryker-tmp-*",
        "**/dist",
        "**/.astro",
        "**/.turbo",
        "**/.wrangler",
        "**/reports",
        "**/.env",
        "**/.env.*",
        "**/.dev.vars",
        "**/.dev.vars.*",
        "**/*.pem",
        "**/*.key",
      ],
      reporters: ["clear-text", "progress", "html"],
      htmlReporter: { fileName: `${pkg}/reports/mutation/mutation.html` },
    },
  };
}
