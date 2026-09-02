import cloudflare from "@astrojs/cloudflare";
import solidJs from "@astrojs/solid-js";
import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, sessionDrivers } from "astro/config";

/**
 * `motion` (plus its `motion-dom`/`motion-utils` deps) is ~187 KB raw of dead
 * weight in the SSR Worker build (tracker #287). The three `.motion.ts`
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
        '"motion is stubbed out of the cire/invites SSR build (tracker #287); ' +
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
  // We don't use Astro sessions at all (no `Astro.session` reads/writes). Left to
  // its default the Cloudflare adapter auto-provisions a KV session driver and a
  // `SESSION` KV binding the deploy would then require. Pin an in-memory driver
  // so the adapter injects NO KV binding — keeping the Worker deploy binding-free
  // (no manual KV namespace to create). The store is never exercised.
  session: { driver: sessionDrivers.memory() },
  integrations: [solidJs()],
  vite: {
    plugins: [tailwindcss(), stubMotionForSsr()],
  },
});
