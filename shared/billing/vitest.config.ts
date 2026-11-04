import { defineConfig } from "vitest/config";

// `tests/d1/` boots workerd through Miniflare; only `test:d1` runs it.
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"], exclude: ["tests/d1/**"] },
});
