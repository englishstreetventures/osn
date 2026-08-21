import { defineConfig } from "vitest/config";

// Its own config, not `vite.config.ts`: that one is the dev server's, and the
// tests here need none of it.
//
// Deliberately without `vite-plugin-solid`, unlike every other Solid package in
// the repo. The plugin adds `@testing-library/jest-dom/vitest` to `setupFiles`
// for any test run, which fails outright unless the package carries that
// dependency — and a dev tool testing two pure functions has no reason to pull
// in a DOM matcher library. The cost is that nothing here can import a `.tsx`
// file, which is why `inferControl` lives in its own module.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
