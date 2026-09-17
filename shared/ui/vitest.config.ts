/**
 * Two test projects, deliberately separated — the same split `@cire/host`,
 * `@musubi/social` and `@pulse/web` run.
 *
 * The `unit` project parses no stylesheet and computes no layout, which for a
 * component library is a sharper limit than it sounds: it can assert a
 * component's class list and its DOM shape, but not that a class emitted CSS,
 * won the cascade, or painted anything.
 *
 * `Modal` is the case that forced the split. It is built on `<dialog>` +
 * `showModal()`, and essentially everything worth having about that is
 * unobservable in a DOM shim — the top layer, the focus trap, background
 * inertness, `::backdrop`, Escape. A shim assertion that the element exists
 * would pass just as happily against a `<div>` wearing the same classes.
 *
 * Browser tests are named `*.browser.test.ts(x)` and excluded from `unit` by
 * that name, so every file lands in exactly one project.
 */

import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

import { emulateMedia } from "./tests/test-support/browser-commands.ts";

/**
 * Escape hatch for environments that ship a prebuilt Chromium whose build number
 * doesn't match the pinned Playwright — dev containers and this repo's cloud
 * sessions both provide one under `$PLAYWRIGHT_BROWSERS_PATH` and set
 * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. CI installs the matching browser and
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
        // Tailwind here and not in `unit`: the browser tier asserts painted
        // colour, and without a real build every contract utility resolves to
        // nothing while every string assertion still passes.
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
            // Lets a test flip `prefers-reduced-motion` for itself instead of
            // running the whole suite twice under a second browser instance.
            commands: { emulateMedia },
          },
        },
      },
    ],
  },
});
