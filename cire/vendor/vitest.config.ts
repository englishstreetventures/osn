/**
 * Two test projects, the same split `@cire/host` runs, and for the same reason.
 *
 * `happy-dom` (the `unit` project's per-file environment) parses no stylesheet
 * and computes no layout: `getComputedStyle` gives back roughly what was set
 * inline, and Tailwind's generated CSS never exists at all. So the fast tier can
 * assert that an element carries `rounded-ui-field`, but never that the class
 * emitted any CSS or what corner the portal's role map resolves it to.
 *
 * Browser tests are named `*.browser.test.ts(x)` and are excluded from `unit` by
 * that name, so every file lands in exactly one project.
 */

import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * Escape hatch for environments that ship a prebuilt Chromium whose build number
 * doesn't match the pinned Playwright (dev containers and this repo's cloud
 * sessions both provide one under `$PLAYWRIGHT_BROWSERS_PATH` and set
 * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). CI installs the matching browser and
 * leaves this unset. Declared in `turbo.json` under `passThroughEnv`.
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
        // The Tailwind build the app ships: `global.css` is
        // `@import "tailwindcss"`, and a test that imports it gets the real
        // generated stylesheet only through this plugin.
        plugins: [solid(), tailwindcss()],
        test: {
          name: "browser",
          include: ["tests/**/*.browser.test.{ts,tsx}"],
          passWithNoTests: true,
          browser: {
            enabled: true,
            // `launchOptions` belongs to the PROVIDER, not to an entry in
            // `instances` — passed there it is accepted and silently ignored.
            provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
            // `headless` must sit at this level too: set inside `instances` it
            // does not take effect (vitest-dev/vitest#7661).
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
