import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Pure static marketing site for OSN. The landing page is the same for every
// visitor (unlike the identity app `@osn/social`, which is per-user), so it
// prerenders to plain HTML and deploys to Cloudflare Pages exactly like cire's
// landing — no Cloudflare adapter is needed for a static build.
export default defineConfig({
  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "static",
  // Canonical site origin, baked in for SEO meta (og:url, canonical). This is a
  // PLACEHOLDER canonical origin — overridden per-deploy via the `SITE` build
  // var so a preview deploy advertises its own URL and the production deploy
  // advertises the real apex.
  site: process.env.SITE ?? "https://osn.social",
  integrations: [solidJs()],
  vite: {
    plugins: [tailwindcss()],
  },
});
