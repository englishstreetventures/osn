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
 * Move the real pointer to a point on an element, in `steps` moves from where
 * it is now. `x` and `y` are fractions of the element's box, so `0.5, 0.5` is
 * its centre and `0.5, 1.2` is just below it.
 *
 * Playwright's mouse sends input through the browser, which then fires
 * `pointerleave`, `pointerenter` and `pointermove` in its own order. A test that
 * dispatched those events itself would set the order it is meant to check, so a
 * claim about how a hover panel behaves while the pointer crosses to it needs
 * the real thing. The box is read through the test's frame, so a scaled or
 * offset iframe still lands on the element.
 */
export const movePointer = defineBrowserCommand<
  [{ selector: string; x?: number; y?: number; steps?: number }]
>(async (ctx, { selector, x = 0.5, y = 0.5, steps = 1 }) => {
  const box = await ctx.iframe.locator(selector).first().boundingBox();
  if (!box) throw new Error(`nothing to point at: ${selector}`);
  await ctx.page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps });
});

/**
 * Move the real pointer to the centre of an element and hold its button down,
 * until `releasePointer`. A press is `:active` only while the browser holds a
 * real button down on the element: a dispatched `pointerdown` or `mousedown`
 * sets no `:active`, so a claim about how a pressed control looks needs real
 * input. The box is read through the test's frame, as `movePointer` reads it.
 */
export const pressPointer = defineBrowserCommand<[{ selector: string }]>(
  async (ctx, { selector }) => {
    const box = await ctx.iframe.locator(selector).first().boundingBox();
    if (!box) throw new Error(`nothing to press: ${selector}`);
    await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await ctx.page.mouse.down();
  },
);

/** Let go of the button `pressPointer` holds down, where the pointer is now. */
export const releasePointer = defineBrowserCommand<[]>(async (ctx) => {
  await ctx.page.mouse.up();
});

/**
 * Hold a key down until `releaseKey` lets it go: `" "` holds Space, which a
 * browser treats as a press on a focused button while it is held. Keys go to
 * whatever has focus, so focus the element first.
 */
export const holdKey = defineBrowserCommand<[string]>(async (ctx, key) => {
  await ctx.page.keyboard.down(key);
});

/** Let go of a key `holdKey` holds down. */
export const releaseKey = defineBrowserCommand<[string]>(async (ctx, key) => {
  await ctx.page.keyboard.up(key);
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
