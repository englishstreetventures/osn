import { configDefaults, defineConfig } from "vitest/config";

// `tests/d1/` holds the Miniflare-backed integration tier: it imports `bun:test`
// and boots a real workerd instance, so it runs under `bun run test:d1` rather
// than here. Excluded by path so the fast tier never tries to load it.
//
// `configDefaults.exclude` is spread rather than retyped: naming `exclude` at
// all REPLACES vitest's default list, so an explicit array silently drops
// `**/.git/**` along with anything a future vitest adds to it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/dist/**", "tests/d1/**"],
  },
});
