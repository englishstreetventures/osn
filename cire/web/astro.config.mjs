import cloudflare from "@astrojs/cloudflare";
import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, sessionDrivers } from "astro/config";

// SSR on a Cloudflare Worker. The invite route resolves which wedding to render
// FROM THE PATH at request time (`/<slug>`), so the guest site no longer bakes a
// single wedding slug at build time — any wedding renders from its own link. The
// `@astrojs/cloudflare` adapter emits `dist/server/entry.mjs` + `dist/client/`
// and a generated `dist/server/wrangler.json` extending `./wrangler.jsonc`;
// `wrangler deploy` from this directory ships it (see deploy.yml). Legal pages
// opt back into static prerendering per-page (`export const prerender = true`)
// — only the dynamic invite + bare-domain routes need per-request SSR.
export default defineConfig({
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
    plugins: [tailwindcss()],
  },
});
