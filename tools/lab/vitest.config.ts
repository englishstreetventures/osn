import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Its own config, not `vite.config.ts`: that one is the dev server's, and the
// tests here need none of it.
//
// `vite-plugin-solid` is here so the story smoke test can import `.tsx` story
// files and render them. The plugin also prepends
// `@testing-library/jest-dom/vitest` to `setupFiles` unless an existing entry's
// path already contains `jest-dom`, which is what the marker file is for: this
// package tests two pure functions and a render pass, and has no use for a DOM
// matcher library.
export default defineConfig({
  plugins: [solid()],
  // Bun installs solid-js into each workspace's own node_modules rather than
  // hoisting it, so a story imported from `pulse/web` resolves a *second* copy
  // of the runtime. Two Solid instances do not share a reactive graph, and a
  // story that renders fine in the dev server then throws here. Same dedupe as
  // `vite.config.ts`, for the same reason.
  resolve: { dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
  test: {
    // Node by default; the story smoke test asks for `happy-dom` with a
    // first-line `// @vitest-environment` pragma, so the pure-function tests
    // keep paying nothing for a DOM they never touch.
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
  },
});
