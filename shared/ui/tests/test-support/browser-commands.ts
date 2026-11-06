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
 *
 * `forcedColors` emulates a Windows contrast theme, under which the browser
 * replaces author colours with system ones and drops `box-shadow`.
 *
 * Restore the preference (`{ reducedMotion: "no-preference" }`) in an
 * `afterEach`, or in an `afterAll` when every test in the file wants it: the
 * browser context is shared across tests in a file, so a leaked preference
 * silently changes every later assertion about animation.
 *
 * A twin of `cire/invites/tests/test-support/browser-commands.ts`, and
 * deliberately a copy rather than a shared module — it is four lines, and a
 * `@shared/*` package existing only to hold a Playwright command that two test
 * configs register is more machinery than the duplication costs.
 */
export const emulateMedia = defineBrowserCommand<
  [{ reducedMotion?: "reduce" | "no-preference"; forcedColors?: "active" | "none" }]
>(async (ctx, options) => {
  await ctx.page.emulateMedia(options);
});

/**
 * Fail every request the calling test file's frame makes for a URL matching
 * `pattern` (a Playwright glob), as a dropped connection does, until
 * `allowRequests` is called with the same pattern. Other files' frames fetch as
 * usual, so a file that runs beside this one is not affected.
 */
export const failRequests = defineBrowserCommand<[string]>(async (ctx, pattern) => {
  const frame = await ctx.frame();
  await ctx.page.route(pattern, (route) =>
    route.request().frame() === frame ? route.abort("failed") : route.fallback(),
  );
});

/** Undo `failRequests` for `pattern`. */
export const allowRequests = defineBrowserCommand<[string]>(async (ctx, pattern) => {
  await ctx.page.unroute(pattern);
});
