/**
 * The Vitest config `stryker/config.mjs` runs. Stryker starts Vitest from the
 * repo root, so `root` pins it back to this package, where the `include` and
 * `setupFiles` paths of `vitest.config.ts` are written from.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import base from "../vitest.config.ts";

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("..", import.meta.url)),
  // In Stryker's sandbox the `@cire/ui` `.astro?raw` import in
  // tests/legal-pages.test.ts resolves to this checkout's cire/ui, outside the
  // sandbox root, and Vite's file-access check fails the dry run on it. Nothing
  // is served from here, so the check is off.
  server: { fs: { strict: false } },
});
