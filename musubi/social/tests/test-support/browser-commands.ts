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
 * Fails every request whose path ends with `pathSuffix`, as the network does
 * when a chunk is missing or the browser is offline: a dynamic import of that
 * module rejects in the page. `restoreRequests` lifts it; call it in the
 * `afterEach` or `afterAll` that pairs with the hook that set it, since
 * routing outlives the test that set it.
 */
export const failRequests = defineBrowserCommand<[pathSuffix: string]>(async (ctx, pathSuffix) => {
  await ctx.page.route(
    (url) => url.pathname.endsWith(pathSuffix),
    (route) => route.abort("internetdisconnected"),
  );
});

export const restoreRequests = defineBrowserCommand<[]>(async (ctx) => {
  await ctx.page.unrouteAll({ behavior: "ignoreErrors" });
});

/**
 * Teach `commands` about the commands above, so a call site needs no cast and
 * a re-shaped command is a type error rather than a runtime failure.
 */
declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMedia: (options: {
      reducedMotion?: "reduce" | "no-preference";
      forcedColors?: "active" | "none";
    }) => Promise<void>;
    failRequests: (pathSuffix: string) => Promise<void>;
    restoreRequests: () => Promise<void>;
  }
}

/**
 * A PNG, as base64, of what the page paints over an element's box `pad` CSS
 * pixels out on every side, drawn at `scale` device pixels per CSS pixel — 1
 * for most desktop screens, 2 for a phone's or a Retina one. Sub-pixel layout
 * is snapped to device pixels when it paints, so a claim that one painted
 * thing is centred in another holds only at the ratios it was measured at.
 *
 * Through the DevTools protocol, not `page.screenshot`: Playwright puts the
 * context's own ratio back before it shoots, and a device pixel ratio is the
 * browser context's, fixed when it opens. The ratio is set back to 1 after.
 */
// A twin of `paintedBox` in `shared/ui/tests/test-support/browser-commands.ts`.
export const paintedBox = defineBrowserCommand<[{ selector: string; scale: 1 | 2; pad?: number }]>(
  async (ctx, { selector, scale, pad = 4 }): Promise<{ png: string; scale: number }> => {
    const session = await ctx.page.context().newCDPSession(ctx.page);
    const size = ctx.page.viewportSize() ?? { width: 414, height: 896 };
    const metrics = (deviceScaleFactor: number) =>
      session.send("Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor,
        mobile: false,
      });
    try {
      await metrics(scale);
      const frame = await ctx.frame();
      // Two frames, so layout and paint have both run at the new ratio.
      await frame.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const box = await ctx.iframe.locator(selector).first().boundingBox();
      if (!box) throw new Error(`nothing painted: ${selector}`);
      const shot = await session.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: box.x - pad,
          y: box.y - pad,
          width: box.width + 2 * pad,
          height: box.height + 2 * pad,
          scale: 1,
        },
      });
      return { png: shot.data, scale };
    } finally {
      await metrics(1);
      await session.detach();
    }
  },
);
