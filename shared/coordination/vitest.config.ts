import { configDefaults, defineConfig } from "vitest/config";

// `tests/d1/` is the Miniflare tier: it imports `bun:test` and boots workerd,
// so it runs under `bun run test:d1` and is excluded here by path.
// `configDefaults.exclude` is spread because naming `exclude` replaces the
// default list.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/d1/**"],
  },
});
