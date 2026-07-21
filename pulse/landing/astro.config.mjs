import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Pure static marketing site for Pulse. Like cire/landing it prerenders to plain
// HTML (the page is the same for everyone) and deploys to Cloudflare Pages —
// `wrangler pages deploy dist`. No Cloudflare adapter is needed for a static
// build; there is no first-party API call from this site.
export default defineConfig({
  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "static",
  // Canonical site origin, baked in for SEO meta (og:url, canonical). This is a
  // PLACEHOLDER canonical origin — overridden per-environment via the `SITE`
  // build var so a preview deploy advertises its own URL and the prod deploy
  // advertises the real apex.
  site: process.env.SITE ?? "https://pulse.events",
  integrations: [solidJs()],
  vite: {
    plugins: [tailwindcss()],
  },
});
