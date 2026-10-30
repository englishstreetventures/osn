/**
 * Two test projects, split by filename, as in `@shared/ui` and `@cire/host`.
 *
 * The `unit` project parses no stylesheet and computes no layout: it can
 * assert a class list and a DOM shape, but not that a class emitted CSS, won
 * the cascade, or painted anything. Whether a link wraps with its sentence,
 * whether its underline shows at rest, and what colour its focus ring paints
 * are all of that kind, so they run in the `browser` project, in Chromium.
 *
 * Browser tests are named `*.browser.test.ts(x)` and excluded from `unit` by
 * that name, so every file lands in exactly one project. Stryker runs `unit`
 * alone (`stryker/vitest.config.ts`).
 */

import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * For environments that ship a prebuilt Chromium whose build number does not
 * match the pinned Playwright (dev containers and this repo's cloud sessions).
 * CI installs the matching browser and leaves this unset. Declared in
 * `turbo.json` under `passThroughEnv`.
 */
const executablePath = process.env.VITEST_BROWSER_EXECUTABLE_PATH;

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [solid()],
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.{ts,tsx}"],
          setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
        },
      },
      {
        // Tailwind here and not in `unit`: the browser tier asserts painted
        // colour and layout, and without a real build every contract utility
        // resolves to nothing while every string assertion still passes.
        plugins: [solid(), tailwindcss()],
        test: {
          name: "browser",
          include: ["tests/**/*.browser.test.{ts,tsx}"],
          passWithNoTests: true,
          browser: {
            enabled: true,
            // `launchOptions` belongs to the provider, not to an entry in
            // `instances`, where it is accepted and ignored.
            provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
            // At this level: inside `instances` it does not take effect
            // (vitest-dev/vitest#7661).
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
