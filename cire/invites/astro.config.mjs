import cloudflare from "@astrojs/cloudflare";
import solidJs from "@astrojs/solid-js";
import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

/**
 * Minify the SSR build. The plain config form —
 * `vite: { build: { minify: true } }` — is a no-op: `createViteBuildConfig`
 * (`astro/dist/core/build/vite-build-config.js:36`) spreads the user's
 * `vite.build` into its own object, but line 100 hard-sets `minify: false`
 * afterward ("improve build performance"), overriding it again. The `ssr`
 * environment's build config (`:164-174`) replaces the whole `build` key with
 * just `{ outDir, rolldownOptions }`, so a `vite.environments.ssr.build.minify`
 * would be dropped too — there is no config field left for the SSR build to
 * read `minify` from.
 *
 * The only place that still takes a user value is `astro:build:setup`
 * (`astro/dist/integrations/hooks.js:400` `runHookBuildSetup`), which Astro
 * runs once with `target: "server"` (`astro/dist/core/build/static-build.js:188`)
 * AFTER `createViteBuildConfig` has already produced the config above, and
 * whose `updateConfig` merges on top via `mergeViteConfig` — winning over the
 * `minify: false` set earlier. The merged value lands on the top-level
 * `build.minify`, which the `prerender` and `ssr` environments inherit (neither
 * sets its own `build.minify`); the `client` environment does not inherit it,
 * because its value is baked in separately
 * (`vite-build-config.js:136`, `userClient?.build?.minify ?? viteConfig.build?.minify ?? true`)
 * — so the client bundle stays exactly as minified as before this change.
 *
 * The minifier under this Astro/Vite (7.2.10 → Vite 8 / rolldown-vite) is OXC,
 * not esbuild — `minify: true` selects it; do not pass `"esbuild"`.
 *
 * `sourcemap` goes through the SAME hook, and it has to. Minified server output
 * means a production Worker exception no longer names a real source line, so
 * the maps are what make `wrangler.jsonc`'s `upload_source_maps` worth setting.
 * But `sourcemap` is NOT overridden the way `minify` is: written as a plain
 * `vite: { build: { sourcemap: true } }` it rides the `...viteConfig.build`
 * spread at `:36` into the top level AND is read by the client environment at
 * `:135` (`userClient?.build?.sourcemap ?? viteConfig.build?.sourcemap ?? false`)
 * — so it emits `dist/client/_astro/*.js.map` too. `dist/client` is this
 * Worker's Static Assets directory (the adapter writes
 * `"assets": { "directory": "../client" }` into the generated wrangler config),
 * and Cloudflare serves any file there verbatim, so those maps would publish
 * the guest site's unminified source at `/_astro/<chunk>.js.map` to anyone
 * asking. Setting it here instead lands it on the top-level `build` AFTER `:135`
 * has already baked the client's own `sourcemap: false`, so only the server and
 * prerender builds emit maps. If you ever move this back to plain `vite.build`,
 * check `dist/client` for `.map` files before you deploy.
 */
function minifySsrBuild() {
  return {
    name: "cire-invites:minify-ssr-build",
    hooks: {
      "astro:build:setup"({ updateConfig }) {
        updateConfig({ build: { minify: true, sourcemap: true } });
      },
    },
  };
}

/**
 * `zod` is NOT stubbed like `motion` below, and stays in
 * `dist/server` on purpose — this bundle traced it, unlike `motion`, to a
 * module that genuinely runs on every request.
 *
 * `src/actions` doesn't exist in this app, but Astro's own request pipeline
 * doesn't gate on that: `core/routing/handler.js`'s `actionsAndPages()` calls
 * `handleAction(ctx, state)` (from `actions/handler.js`) on every
 * non-prerendered request unless `state.skipMiddleware` is set, which nothing
 * here sets. `actions/handler.js` imports `getActionContext` from
 * `actions/runtime/server.js:6`, and that file's first line is
 * `import * as z from "zod/v4/core"` — a static, top-level import, so it loads
 * whether or not the request actually names an action. `getActionContext`
 * itself just returns early when there's no action to run, but by then the
 * module (and `zod/v4/core`) is already part of the SSR chunk graph. There is
 * no `actions: false`-style config to opt out of this path — grepped
 * `astro/dist/core/config` for an actions schema key and found none.
 *
 * Turning off sessions (`session: false` below) does NOT touch
 * this: the zod import that session config used to pull in
 * (`astro/dist/core/session/config.js:1`, `zod/v4`) is a separate module from
 * the actions one, and the fingerprint grep below still finds
 * `ZodError`/`Invalid input` strings in `dist/server` after the sessions
 * change, source-mapping back to `actions/runtime/server.js`, not to any
 * session file:
 *
 *   grep -rlE 'ZodError|\$ZodError|z\.core|Invalid input' dist/server
 *
 * So #617 stays open on its own: astro's actions runtime is the entry, it
 * runs at request time, and there's no app-level lever to remove it.
 */
/**
 * `motion` (plus its `motion-dom`/`motion-utils` deps) is ~187 KB raw of dead
 * weight in the SSR Worker build. The three `.motion.ts`
 * modules that import it — `components/Modal.motion.ts`,
 * `designs/gala/UnlockReveal.motion.ts`, `designs/classic/UnlockReveal.motion.ts`
 * — are only ever reached from a SolidJS `onMount` prefetch hint or a DOM
 * event handler (modal open/close, the post-claim reveal), both of which are
 * client-only and never run while the server renders HTML. But Vite's SSR
 * build still walks and chunks every module reachable via `import()`,
 * dynamic imports included, so the whole library ships in `dist/server` with
 * nothing there ever calling it.
 *
 * Stub `motion` out of the SSR module graph only. The client build (this
 * plugin only intercepts `options.ssr` resolutions) still resolves the real
 * package, so both design packs keep animating exactly as before — verify
 * with a client build + `dist/client` inspection after touching this.
 *
 * The stub exports only what the `.motion.ts` modules use today: `animate` and
 * `stagger`. A module reaching for any other `motion` export (`inView`,
 * `scroll`, `spring`) resolves to a stub that does not have it and breaks the
 * SSR build. Add the export here rather than deleting this plugin — dropping it
 * puts 47 KB gzip back into the Worker.
 */
function stubMotionForSsr() {
  const STUB_ID = "\0cire-invites:motion-stub-ssr";
  return {
    name: "cire-invites:stub-motion-for-ssr",
    enforce: "pre",
    resolveId(source, _importer, options) {
      // Strip any Vite query suffix (`?url`, `?raw`) before matching, and cover
      // the two sibling packages `motion` re-exports from — a bare `motion-dom`
      // or `motion-utils` import would otherwise walk straight past this stub
      // and put the same bytes back into the server graph.
      const bare = source.split("?")[0];
      if (options?.ssr && /^motion(-dom|-utils)?(\/|$)/.test(bare)) {
        return STUB_ID;
      }
      return null;
    },
    load(id) {
      if (id !== STUB_ID) return null;
      // Thrown, not a silent no-op: if a future code path ever calls these
      // during SSR, that is exactly the assumption above being wrong. How loud
      // that is depends on the caller — `Modal.motion.ts:27` lets it propagate,
      // but both `UnlockReveal.motion.ts` files catch and resolve, so an SSR
      // call there degrades to no animation rather than an error. A throw is
      // still better than a silent no-op: it is at least visible in a stack
      // trace and in any caller that does not swallow it.
      const throwStub =
        "() => { throw new Error(" +
        '"motion is stubbed out of the cire/invites SSR build; ' +
        'animate()/stagger() must only run client-side"); }';
      return `export const animate = ${throwStub};\nexport const stagger = ${throwStub};\n`;
    },
  };
}

// SSR on a Cloudflare Worker. The invite route resolves which wedding to render
// FROM THE PATH at request time (`/<slug>`), so the guest site no longer bakes a
// single wedding slug at build time — any wedding renders from its own link. The
// `@astrojs/cloudflare` adapter emits `dist/server/entry.mjs` + `dist/client/`
// and a generated `dist/server/wrangler.json` extending `./wrangler.jsonc`;
// `wrangler deploy` from this directory ships it (see deploy.yml). Legal pages
// opt back into static prerendering per-page (`export const prerender = true`)
// — only the dynamic invite + bare-domain routes need per-request SSR.
export default defineConfig({
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running
  // `dev:app` directly), where every Astro app would otherwise fight over the
  // default 4321.
  server: { port: devPort(4321) },

  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "server",
  adapter: cloudflare({
    // The guest site does no image transforms of its own — invite images are
    // transformed by cire-api (Cloudflare Images binding) on its own serve path.
    // `passthrough` keeps Astro's <Image>/asset handling inert so the adapter
    // doesn't require a Cloudflare Images binding on THIS Worker.
    imageService: "passthrough",
  }),
  // We don't use Astro sessions at all (no `Astro.session` reads/writes). Astro's
  // own schema accepts `session: false` (`astro/dist/core/session/config.js:29`,
  // `SessionSchema = z.union([z.literal(false), SessionObjectSchema])`), and the
  // Cloudflare adapter's auto-provision check is gated on that same literal
  // (`@astrojs/cloudflare/dist/index.js:107`, `if (session !== false && ...)`) —
  // so `false` skips the KV-binding provisioning block entirely, same as it did
  // for the in-memory driver, but also drops the session runtime and `unstorage`
  // from the SSR module graph, since there is no longer a driver
  // to load at all.
  session: false,
  integrations: [solidJs(), minifySsrBuild()],
  vite: {
    plugins: [tailwindcss(), stubMotionForSsr()],
  },
});
