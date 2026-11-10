/**
 * `motion` is dead weight in the SSR Worker build. The one module that imports
 * it, `components/EventSheet.tsx`, only calls it from a touch's release, in a
 * sheet the server never renders open, so it never runs while the server
 * renders HTML. Vite's SSR build still walks and chunks every module
 * reachable via `import()`, dynamic imports included. Nothing the server build
 * keeps calls `animate`, so the bundler already shakes the library out of
 * `dist/server` with or without this plugin; the plugin keeps it out when a
 * call lands on a path the server compiles.
 *
 * This Vite plugin stubs the library out of the SSR module graph only. The
 * client build (it only intercepts `options.ssr` resolutions) still resolves
 * the real package, so the sheet's swipe still springs — verify with a client
 * build and a look in `dist/client` after touching this.
 *
 * It stubs the whole family, not just the name the app imports. `motion`'s
 * own entry re-exports `framer-motion/dom`, and `motion-dom` and
 * `motion-utils` are what both build on; a bare import of any of them would
 * otherwise walk straight past the stub and put the same bytes back into the
 * server graph.
 *
 * The stub exports only what `EventSheet` uses today: `animate`. A module
 * reaching for any other export (`stagger`, `inView`, `scroll`, `spring`, or
 * `framer-motion`'s React components) resolves to a stub that does not have
 * it and breaks the SSR build rather than costing bytes. Add
 * the export here rather than deleting this plugin: without it, such a call
 * puts motion's minified cost, about 20 KB gzip, into the Worker.
 *
 * *Measured 2026-11-11 in cire/invites — `echo 'export { animate } from "motion";'
 * | bunx --bun esbuild --bundle --minify --format=esm --platform=browser
 * | gzip -nc | wc -c`: 20362 bytes. Removing the plugin from `astro.config.mjs`
 * and running `npx astro build` moved the `dist/server` gzip total by under
 * 10 bytes.*
 */
export const MOTION_SSR_STUB_ID = "\0cire-invites:motion-stub-ssr";

/** `motion`, `motion-dom`, `motion-utils` and `framer-motion`, with any subpath. */
const MOTION_FAMILY = /^(framer-)?motion(-dom|-utils)?(\/|$)/;

export function stubMotionForSsr() {
  return {
    name: "cire-invites:stub-motion-for-ssr",
    enforce: "pre" as const,
    resolveId(
      source: string,
      _importer: string | undefined,
      options: { readonly ssr?: boolean } | undefined,
    ): string | null {
      // Strip any Vite query suffix (`?url`, `?raw`) before matching.
      const bare = source.split("?")[0] ?? source;
      if (options?.ssr && MOTION_FAMILY.test(bare)) {
        return MOTION_SSR_STUB_ID;
      }
      return null;
    },
    load(id: string): string | null {
      if (id !== MOTION_SSR_STUB_ID) return null;
      // Thrown, not a silent no-op: if a future code path ever calls this
      // during SSR, that is exactly the assumption above being wrong, and a
      // throw shows in a stack trace where a no-op would show nothing.
      const throwStub =
        "() => { throw new Error(" +
        '"motion is stubbed out of the cire/invites SSR build; ' +
        'animate() must only run client-side"); }';
      return `export const animate = ${throwStub};\n`;
    },
  };
}
