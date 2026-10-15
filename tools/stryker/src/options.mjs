/**
 * The Stryker options every cire package's `stryker/config.mjs` shares. Each config
 * spreads `options` and adds its own runner.
 *
 * `tools/stryker` runs Stryker from the repo root, so the sandbox is
 * a copy of the whole repository and every path here is root-relative.
 * `ignorePatterns` is the only control over what that copy holds: Stryker does
 * not read `.gitignore`, so local secret files are listed here, and nothing a
 * cire test reads may be.
 */

import { basename, dirname, relative } from "node:path";

/** @param {string} configDir the package's `stryker/` directory, `import.meta.dirname` of its config */
export function cireStryker(configDir) {
  const pkgDir = dirname(configDir);
  const pkg = relative(process.cwd(), pkgDir);
  return {
    pkg,
    options: {
      // Setting `mutate` replaces Stryker's default exclusion of test files.
      mutate: [
        `${pkg}/src/**/*.{ts,tsx}`,
        `!${pkg}/src/**/*.d.ts`,
        `!${pkg}/src/**/*.{test,spec}.{ts,tsx}`,
      ],
      tempDirName: `.stryker-tmp-cire-${basename(pkgDir)}`,
      cleanTempDir: "always",
      ignorePatterns: [
        ".claude",
        "wiki",
        // No cire test or config reads the other products; the copy skips them.
        "osn",
        "pulse",
        "musubi",
        "zap",
        "docs",
        "tools",
        ".agents",
        ".changeset",
        "**/coverage",
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
      // Read by `--incremental`, which reuses every result whose code and
      // covering tests are unchanged. Only the vitest runner reports coverage;
      // under the command runner it would keep a survivor after a killing test.
      incrementalFile: `${pkg}/reports/mutation/stryker-incremental.json`,
      reporters: ["clear-text", "progress", "html"],
      htmlReporter: { fileName: `${pkg}/reports/mutation/mutation.html` },
    },
  };
}
