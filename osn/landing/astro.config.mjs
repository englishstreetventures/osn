import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

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

  // Every face is downloaded at build time and served from our own origin. The
  // three page shells used to <link> fonts.googleapis.com, which cost a DNS
  // lookup, a TLS handshake and a render-blocking round trip to a third party
  // before a single word could paint — and told Google LLC (US) the IP and
  // user-agent of every visitor, with no consent gate in front of it
  // (`xchromo/osn-tracker#388`). Astro's pipeline also emits the preload links
  // and the fallback metrics (`optimizedFallbacks`), so the swap from fallback
  // face to real face doesn't shift the layout.
  //
  // Self-hosting is also what lets `public/_headers` drop both Google origins
  // from `style-src` and `font-src`.
  fonts: [
    {
      // Headings and the wordmark.
      name: "Space Grotesk",
      cssVariable: "--font-space-grotesk",
      provider: fontProviders.google(),
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["system-ui", "sans-serif"],
      optimizedFallbacks: true,
    },
    {
      // Body copy.
      name: "Inter",
      cssVariable: "--font-inter",
      provider: fontProviders.google(),
      weights: [400, 500, 600],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["system-ui", "sans-serif"],
      optimizedFallbacks: true,
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
