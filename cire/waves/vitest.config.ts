/**
 * Two test projects, split by filename, as in `@cire/ui`.
 *
 * Both waves are WebGL 2, View Transitions and layout, none of which a DOM
 * emulator has, so their tests run in the `browser` project, in Chromium.
 * Browser tests are named `*.browser.test.ts(x)` and excluded from `unit` by
 * that name, so every file lands in exactly one project. The `unit` project
 * runs in Node: it builds the package with Vite to check what a production
 * bundle carries and leaves out. Stryker runs both (`stryker/vitest.config.ts`):
 * the browser project is the only one that runs the waves' code.
 */

import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

import { emulateMedia } from "./tests/test-support/browser-commands.ts";

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
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.{ts,tsx}"],
          setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
        },
      },
      {
        plugins: [solid()],
        test: {
          name: "browser",
          include: ["tests/**/*.browser.test.{ts,tsx}"],
          browser: {
            enabled: true,
            // `launchOptions` belongs to the provider, not to an entry in
            // `instances`, where it is accepted and ignored.
            provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
            // At this level: inside `instances` it does not take effect
            // (vitest-dev/vitest#7661).
            headless: true,
            instances: [{ browser: "chromium" }],
            // A test flips `prefers-reduced-motion` for itself.
            commands: { emulateMedia },
          },
        },
      },
    ],
  },
});
