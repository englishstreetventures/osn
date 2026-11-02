import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

// `tests/d1/` holds the Miniflare-backed integration tier: it imports `bun:test`
// and boots a real workerd instance, so it runs under `bun run test:d1` rather
// than here. Excluded by path so the fast tier never tries to load it.
//
// `configDefaults.exclude` is spread rather than retyped: naming `exclude` at
// all REPLACES vitest's default list, so an explicit array silently drops
// `**/.git/**` along with anything a future vitest adds to it.
const INCLUDE = "tests/**/*.test.ts";
const EXCLUDE = [...configDefaults.exclude, "**/dist/**", "tests/d1/**"];

// Most files share a worker's module cache (`isolate: false`), so the app and
// its dependencies load once per worker instead of once per file. A file that
// replaces modules cannot share it: `vi.mock` cannot apply to a module another
// file in the worker already loaded, and `vi.resetModules` clears the cache for
// every file after it. Those files run in their own project with default
// isolation, chosen by reading each file here, so a new one is placed without
// anyone editing this list.
const REPLACES_MODULES = /\bvi\.(?:doMock|mock|resetModules)\(/;
const root = import.meta.dirname;
const replacing = globSync(INCLUDE, { cwd: root, exclude: ["tests/d1/**"] }).filter((file) =>
  REPLACES_MODULES.test(readFileSync(join(root, file), "utf8")),
);

// Restores what one file can leave behind for the next in a shared worker.
const setupFiles = ["./tests/setup/reset-between-files.ts"];

export default defineConfig({
  test: {
    environment: "node",
    setupFiles,
    projects: [
      {
        extends: true,
        test: {
          name: "shared",
          isolate: false,
          include: [INCLUDE],
          exclude: [...EXCLUDE, ...replacing],
        },
      },
      ...(replacing.length > 0
        ? [{ extends: true, test: { name: "isolated", include: replacing, exclude: EXCLUDE } }]
        : []),
    ],
  },
});
