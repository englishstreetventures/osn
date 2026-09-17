/**
 * Two test projects, deliberately separated — the same split `@cire/host` runs,
 * and for the same reason.
 *
 * The `unit` project's environment parses no stylesheet and computes no layout.
 * It can assert that an element carries `base:bg-ui-accent`, but never that the
 * class emitted any CSS, that it won the cascade, or what colour actually
 * reached the pixel. Since the design-token contract landed, that gap is the
 * whole question: a contract utility is three hops from a value
 * (`bg-ui-accent` → `--color-ui-accent` → `--ui-accent` → `--primary`), and
 * every one of those hops can be broken in a way the fast tier reports as green.
 * A class Tailwind cannot generate emits nothing at all, silently.
 *
 * Browser tests are named `*.browser.test.ts(x)` and excluded from `unit` by
 * that name, so every file lands in exactly one project.
 */

import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/** Shared by both projects — same compiler, and the Tailwind build the app
 *  ships. The browser tier needs it: `App.css` is `@import "tailwindcss"`, and
 *  a test only gets the real generated stylesheet through this plugin. */
const plugins = () => [solid(), tailwindcss()];

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
        plugins: plugins(),
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.{ts,tsx}"],
          setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
          coverage: {
            provider: "istanbul",
            include: ["src/**/*.{ts,tsx}"],
            // `src/lib/auth.ts` was excluded while it held a single constant. It
            // now carries the Turnstile sitekey normalisation, which has tests —
            // keep it visible so a regression there shows up as a coverage drop.
            exclude: ["src/index.tsx", "src/App.tsx"],
            reporter: ["text", "html"],
          },
        },
      },
      {
        plugins: plugins(),
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
