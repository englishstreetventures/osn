import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

import { emulateMedia } from "./src/test-support/browser-commands.ts";

/**
 * Two test projects, deliberately separated — the same split `@cire/invites` runs,
 * and for the same reason.
 *
 * `happy-dom` (the `unit` project's per-file environment) parses no stylesheet
 * and computes no layout: `getComputedStyle` gives back roughly what was set
 * inline, and Tailwind's generated CSS never exists at all. So the fast tier can
 * assert that an element carries `text-gold-ink`, but never that the class
 * emitted any CSS, that it won the cascade, or what that ink actually contrasts
 * against once every translucent ancestor has been composited under it. The
 * portal's ink tokens are mostly translucent and its ramps are two — that is a
 * lot of contrast the fast tier is structurally unable to see.
 *
 * Browser tests are named `*.browser.test.ts(x)` and are excluded from `unit` by
 * that name, so every file lands in exactly one project.
 */

/** Shared by both projects — same compiler, and the Tailwind build the app ships
 *  (the browser tier needs it: `global.css` is `@import "tailwindcss"`, and a
 *  test that imports it gets the real generated stylesheet only through this). */
const plugins = () => [solid(), tailwindcss()];

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
        plugins: plugins(),
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.{ts,tsx}"],
          // A NON-UTC runner zone, deliberately. Several tests assert that a new
          // event is seeded with "the organiser's own zone" by comparing against
          // `Intl.DateTimeFormat().resolvedOptions().timeZone` — under a UTC
          // runner that string is "UTC", which is also `browserTimeZone`'s
          // hardcoded fallback, so a `browserTimeZone` rewritten as `() => "UTC"`
          // passed them all. Pinning a real zone makes those assertions
          // falsifiable. Scoped to this project: `env` sets the variable in the
          // NODE process, and a browser test's `Intl` reads the browser's zone,
          // not the runner's — see the note on the browser project below.
          env: { TZ: "Australia/Sydney" },
          setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
        },
      },
      {
        plugins: plugins(),
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
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
            // Lets a test flip `prefers-color-scheme` / `prefers-reduced-motion`
            // for itself instead of running the whole suite once per preference.
            commands: { emulateMedia },
            // No `TZ` counterpart here: the test body runs inside Chromium, so
            // its `Intl` resolves the BROWSER's zone and a runner env var can't
            // reach it. Nothing in the browser tier asserts a zone today; a test
            // that needs one should set `contextOptions.timezoneId` instead.
          },
        },
      },
    ],
  },
});
