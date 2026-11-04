/**
 * The third test project, `astro`: `@cire/ui`'s Astro components rendered
 * with Astro's container API, so a test reads the markup a site would serve
 * rather than the component's source text.
 *
 * Its own file because `getViteConfig` builds the Vite config Astro compiles
 * `.astro` files with, which the `unit` project's Solid plugin cannot. Tests
 * are named `*.astro.test.ts`; `unit` excludes them by that name. Stryker
 * leaves this project out (`stryker/vitest.config.ts`): it mutates no `.astro`
 * file.
 */

import { fileURLToPath } from "node:url";

import { getViteConfig } from "astro/config";

export default getViteConfig(
  {
    test: {
      name: "astro",
      environment: "node",
      include: ["tests/**/*.astro.test.ts"],
      setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
    },
  },
  // This package, whatever directory Vitest was started from: Astro takes its
  // root from the working directory when none is given.
  { root: fileURLToPath(new URL(".", import.meta.url)), logLevel: "error" },
);
