import { defineBrowserCommand } from "@vitest/browser-playwright";

/**
 * Browser commands available to `*.browser.test.ts(x)` files.
 *
 * A command runs in the Vitest **node** process with the Playwright `page`
 * handle, while the test body runs inside the browser. That split is why media
 * emulation has to be a command: `prefers-reduced-motion` is a property of the
 * browser context, so nothing running inside the page can change it.
 *
 * The alternative — a second `browser.instances` entry with
 * `contextOptions.reducedMotion` — would run the *entire* suite twice, once per
 * motion preference, to test the handful of rules that care. A per-test command
 * keeps it to the tests that actually assert it.
 */

/**
 * Emulate a media preference for the remainder of the current test.
 *
 * Always restore it in an `afterEach` (`{ reducedMotion: "no-preference" }`) —
 * the browser context is shared across tests in a file, so a leaked preference
 * silently changes every later assertion about animation.
 */
export const emulateMedia = defineBrowserCommand<[{ reducedMotion?: "reduce" | "no-preference" }]>(
  async (ctx, options) => {
    await ctx.page.emulateMedia(options);
  },
);
