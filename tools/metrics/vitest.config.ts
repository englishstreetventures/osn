import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Its own config, not `vite.config.ts`: that one is the dev server's, and the
// tests here need none of it. Mirrors `tools/lab/vitest.config.ts`, including
// the `no-jest-dom` marker that stops `vite-plugin-solid` prepending a DOM
// matcher library this package never uses.
export default defineConfig({
  plugins: [solid()],
  resolve: { dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
  },
});
