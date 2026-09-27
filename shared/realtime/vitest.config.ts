import solid from "vite-plugin-solid";
import { configDefaults, defineConfig } from "vitest/config";

// `tests/d1/` is the Miniflare tier: it imports `bun:test` and boots workerd,
// so it runs under `bun run test:d1` and is excluded here by path.
// `configDefaults.exclude` is spread because naming `exclude` replaces the
// default list. The Solid plugin is what makes `solid-js` resolve to its
// browser build, where effects run; the node build's effects never do.
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/d1/**"],
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
  },
});
