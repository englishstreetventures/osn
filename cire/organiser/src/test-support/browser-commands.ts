import { defineBrowserCommand } from "@vitest/browser-playwright";

/**
 * Browser commands available to `*.browser.test.ts(x)` files.
 *
 * A command runs in the Vitest **node** process with the Playwright `page`
 * handle, while the test body runs inside the browser. That split is why media
 * emulation has to be a command: `prefers-color-scheme` and
 * `prefers-reduced-motion` are properties of the browser context, so nothing
 * running inside the page can change them.
 *
 * The alternative — extra `browser.instances` entries — would run the *entire*
 * suite once per preference to test the handful of rules that care. A per-test
 * command keeps it to the tests that actually assert it.
 *
 * (Mirrors `cire/web`'s command of the same name, with `colorScheme` added: the
 * portal ships two ramps, and the readable-ink contract has to hold in both.)
 */

/**
 * Emulate media preferences for the remainder of the current test.
 *
 * Always restore them in an `afterEach` — the browser context is shared across
 * tests in a file, so a leaked preference silently changes every later
 * assertion. Headless Chromium's own defaults are `light` and `no-preference`.
 */
export const emulateMedia = defineBrowserCommand<
  [{ reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" | "no-preference" }]
>(async (ctx, options) => {
  await ctx.page.emulateMedia(options);
});

/**
 * Teach `commands` about the command above.
 *
 * Vitest builds `commands` from the `BrowserCommands` interface, which only
 * knows its three built-ins — so without this augmentation every call site has
 * to cast, which is what `@cire/web` does today. Declaring it once here keeps
 * the tests reading like ordinary code and means a renamed or re-shaped command
 * is a type error rather than a runtime `undefined is not a function`.
 */
declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMedia: (options: {
      reducedMotion?: "reduce" | "no-preference";
      colorScheme?: "light" | "dark" | "no-preference";
    }) => Promise<void>;
  }
}
