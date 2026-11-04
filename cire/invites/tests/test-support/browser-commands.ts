import { fileURLToPath } from "node:url";

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
 * Emulate a media preference for the remainder of the current test. Always
 * restore it in an `afterEach` (`{ reducedMotion: "no-preference" }`) — the
 * browser context is shared across tests in a file, so a leaked preference
 * silently changes every later assertion about animation.
 */
export const emulateMedia = defineBrowserCommand<[{ reducedMotion?: "reduce" | "no-preference" }]>(
  async (ctx, options) => {
    await ctx.page.emulateMedia(options);
  },
);

/**
 * The guest footer as this site serves it, rendered in the node process by
 * Astro's container API, with the scoped stylesheet of `@cire/ui`'s footer it
 * wraps. A browser test cannot render an `.astro` file itself; this hands it
 * the same markup and CSS a page would carry, so contrast is measured on what
 * a guest sees rather than on a copy of it.
 *
 * Astro's own config file is left out (`configFile: false`): it brings the
 * Cloudflare adapter, which a render needs nothing from. The Solid integration
 * is kept, since the footer holds the guest site's "Privacy choices" island.
 */
export const renderGuestFooter = defineBrowserCommand<
  [{ closing: string | null }],
  Promise<{ html: string; css: string }>
>(async (_ctx, { closing }) => {
  const [
    { default: solidJs },
    { getViteConfig },
    { experimental_AstroContainer },
    { createViteServer },
  ] = await Promise.all([
    import("@astrojs/solid-js"),
    import("astro/config"),
    import("astro/container"),
    import("vitest/node"),
  ]);
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const footerPath = `${root}src/components/GuestFooter.astro`;
  const config = await getViteConfig(
    {},
    { root, configFile: false, integrations: [solidJs()], logLevel: "error" },
  )({ mode: "test", command: "serve" });
  const server = await createViteServer({
    ...config,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  try {
    const footer = await server.ssrLoadModule(footerPath);
    const solid = await server.ssrLoadModule("@astrojs/solid-js/server.js");
    const container = await experimental_AstroContainer.create();
    container.addServerRenderer({ renderer: solid.default });
    container.addClientRenderer({
      name: solid.default.name,
      entrypoint: "@astrojs/solid-js/client.js",
    });
    const html = await container.renderToString(footer.default, { props: { closing } });
    const shared = await server.pluginContainer.resolveId("@cire/ui/site-footer.astro", footerPath);
    if (!shared)
      throw new Error("@cire/ui/site-footer.astro does not resolve from the guest footer");
    const style = await server.ssrLoadModule(
      `${shared.id}?astro&type=style&index=0&inline&lang.css`,
    );
    return { html, css: String(style.default) };
  } finally {
    await server.close();
  }
});
