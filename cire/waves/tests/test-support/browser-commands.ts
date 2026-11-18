import { defineBrowserCommand } from "@vitest/browser-playwright";

/**
 * Browser commands available to `*.browser.test.ts(x)` files.
 *
 * A command runs in the Vitest **node** process with the Playwright `page`
 * handle, while the test body runs inside the browser. `prefers-reduced-motion`
 * is a property of the browser context, so nothing running inside the page can
 * change it.
 *
 * Restore the preference in an `afterEach` (`{ reducedMotion: "no-preference" }`):
 * the browser context is shared across tests in a file.
 *
 * A twin of `cire/ui/tests/test-support/browser-commands.ts`, deliberately a
 * copy: it is four lines.
 */
export const emulateMedia = defineBrowserCommand<
  [{ reducedMotion?: "reduce" | "no-preference"; forcedColors?: "active" | "none" }]
>(async (ctx, options) => {
  await ctx.page.emulateMedia(options);
});
