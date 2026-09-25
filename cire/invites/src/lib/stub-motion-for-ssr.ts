/**
 * `motion` is dead weight in the SSR Worker build. The two modules that
 * import it, `designs/gala/UnlockReveal.motion.ts` and
 * `designs/classic/UnlockReveal.motion.ts`, are only ever reached from a
 * SolidJS `onMount` prefetch hint or the post-claim reveal handler, both of
 * which are client-only and never run while the server renders HTML. But Vite's SSR
 * build still walks and chunks every module reachable via `import()`, dynamic
 * imports included, so the whole library would ship in `dist/server` with
 * nothing there ever calling it.
 *
 * This Vite plugin stubs the library out of the SSR module graph only. The
 * client build (it only intercepts `options.ssr` resolutions) still resolves
 * the real package, so both design packs animate as before — verify with a
 * client build and a look in `dist/client` after touching this.
 *
 * It stubs the whole family, not just the name the app imports. `motion`'s
 * own entry re-exports `framer-motion/dom`, and `motion-dom` and
 * `motion-utils` are what both build on; a bare import of any of them would
 * otherwise walk straight past the stub and put the same bytes back into the
 * server graph.
 *
 * The stub exports only what the `.motion.ts` modules use today: `animate`
 * and `stagger`. A module reaching for any other export (`inView`, `scroll`,
 * `spring`, or `framer-motion`'s React components) resolves to a stub that
 * does not have it and breaks the SSR build rather than costing bytes. Add
 * the export here rather than deleting this plugin — dropping it puts
 * motion's minified cost, about 21 KB gzip, back into the Worker.
 *
 * *Measured 2026-09-25 — `gzip -nc dist/client/_astro/animate.*.js | wc -c`
 * after `bun run --cwd cire/invites build`: 21365 bytes.*
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
      // Thrown, not a silent no-op: if a future code path ever calls these
      // during SSR, that is exactly the assumption above being wrong. How loud
      // that is depends on the caller — both `UnlockReveal.motion.ts` files
      // catch and resolve, so an SSR call there degrades to no animation
      // rather than an error. A throw is still better than a silent no-op: it
      // is visible in a stack trace and in any caller that does not swallow it.
      const throwStub =
        "() => { throw new Error(" +
        '"motion is stubbed out of the cire/invites SSR build; ' +
        'animate()/stagger() must only run client-side"); }';
      return `export const animate = ${throwStub};\nexport const stagger = ${throwStub};\n`;
    },
  };
}
