import { defineBrowserCommand } from "@vitest/browser-playwright";

/**
 * Browser commands available to `*.browser.test.ts(x)` files.
 *
 * A command runs in the Vitest **node** process with the Playwright `page`
 * handle, while the test body runs inside the browser. That split is why media
 * emulation has to be a command: forced colours and `prefers-reduced-motion`
 * are properties of the browser context, so nothing running inside the page
 * can change them.
 *
 * `forcedColors` emulates a Windows contrast theme, under which the browser
 * replaces author colours with system ones and drops `box-shadow`.
 *
 * Restore the preference in an `afterEach`: the browser context is shared
 * across tests in a file, so a leaked preference silently changes every later
 * assertion.
 *
 * A twin of `shared/ui/tests/test-support/browser-commands.ts`, and
 * deliberately a copy rather than a shared module, for the reason given there.
 */
export const emulateMedia = defineBrowserCommand<
  [{ reducedMotion?: "reduce" | "no-preference"; forcedColors?: "active" | "none" }]
>(async (ctx, options) => {
  await ctx.page.emulateMedia(options);
});

/**
 * Teach `commands` about the command above, so a call site needs no cast and
 * a re-shaped command is a type error rather than a runtime failure.
 */
declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMedia: (options: {
      reducedMotion?: "reduce" | "no-preference";
      forcedColors?: "active" | "none";
    }) => Promise<void>;
  }
}
