import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

import { emulateMedia } from "./tests/test-support/browser-commands.ts";

/**
 * Two test projects, deliberately separated.
 *
 * ## Why a second tier exists at all
 *
 * jsdom computes **no CSS and no layout**. `getComputedStyle` returns roughly
 * what was set inline, `getBoundingClientRect` is all zeroes, and the app's
 * stylesheet is never even parsed. That makes a whole class of this app's bugs
 * structurally invisible to the `unit` project below — and they are not
 * hypothetical:
 *
 * - **#203** shipped the Add-to-Calendar popover at `z-90`, below the `z-100`
 *   modal it opens from, so it painted behind the backdrop: invisible and
 *   unclickable. `lib/z-index.test.ts` now guards the *numbers*, which is the
 *   most a jsdom test can do. It cannot check that the popover actually paints
 *   above the modal, that `.z-110` was emitted into the stylesheet at all, or
 *   that no ancestor introduced a stacking context that traps it.
 * - Tailwind v4's `scale-*` utilities set the standalone `scale` property, not
 *   `transform`, so a `transition-transform` that failed to list `scale` would
 *   animate nothing — silently.
 * - Two conflicting utilities on one element resolve by **stylesheet order**,
 *   not class-attribute order: a property of Tailwind's generated output that
 *   can invert under a version bump.
 * - The global `prefers-reduced-motion` clamp is load-bearing for accessibility
 *   and is asserted today only by regex-matching `global.css` as text.
 *
 * The existing answer to all of these is text-matching drift guards
 * (`styles/root-type-scale.test.ts`, `components/rsvp-saved.test.ts`,
 * `components/invite-theme.test.ts`). Those pin that the *source* says the
 * right thing. They can never pin that the *render* does. This project can.
 *
 * ## Why they are separate projects rather than one
 *
 * A real browser costs roughly an order of magnitude more to start than jsdom
 * and needs a downloaded Chromium. Keeping the fast tier fast is the point:
 * `bun run test` — and therefore CI's default path — runs `unit` only. The
 * browser tier is opt-in through `bun run test:browser`, with its own CI step
 * that installs the browser first, mirroring how `test:d1` is already split
 * out.
 *
 * Browser tests are named `*.browser.test.ts(x)` and are excluded from `unit`
 * by that name, so every file lands in exactly one project and neither glob can
 * accidentally swallow the other's files.
 */

/** Shared by both projects — same compiler, and the same Tailwind build the app ships. */
const plugins = () => [solidPlugin(), tailwindcss()];

/**
 * Escape hatch for environments that ship a prebuilt Chromium whose build
 * number doesn't match the pinned Playwright (dev containers and this repo's
 * cloud sessions both provide one under `$PLAYWRIGHT_BROWSERS_PATH` and set
 * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). Without this, Playwright insists on a
 * build it cannot find and the tier is unrunnable there short of a ~300MB
 * download. CI installs the matching browser and leaves this unset.
 */
const executablePath = process.env.VITEST_BROWSER_EXECUTABLE_PATH;

export default defineConfig({
  test: {
    projects: [
      {
        plugins: plugins(),
        test: {
          name: "unit",
          environment: "jsdom",
          transformMode: { web: [/\.[jt]sx?$/] },
          passWithNoTests: true,
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.{ts,tsx}"],
          setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
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
            // Lets a test flip `prefers-reduced-motion` for itself instead of
            // running the whole suite twice under a second browser instance.
            commands: { emulateMedia },
          },
        },
      },
    ],
  },
});
