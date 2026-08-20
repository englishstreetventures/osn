import solidJs from "@astrojs/solid-js";
import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

// Pure static marketing site for Pulse. Like cire/landing it prerenders to plain
// HTML (the page is the same for everyone) and deploys to Cloudflare Pages —
// `wrangler pages deploy dist`. No Cloudflare adapter is needed for a static
// build; there is no first-party API call from this site.
export default defineConfig({
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running
  // `dev:app` directly), where every Astro app would otherwise fight over the
  // default 4321.
  server: { port: devPort(4325) },

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
      // Display face. Instrument Serif ships one weight; the italic is a
      // separate file, and the marketing page sets both.
      name: "Instrument Serif",
      cssVariable: "--font-instrument-serif",
      provider: fontProviders.google(),
      weights: [400],
      styles: ["normal", "italic"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["Georgia", "serif"],
      optimizedFallbacks: true,
    },
    {
      name: "Geist",
      cssVariable: "--font-geist",
      provider: fontProviders.google(),
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["system-ui", "sans-serif"],
      optimizedFallbacks: true,
    },
    {
      // Real tabular numerals for the ticker and the category chips.
      name: "Geist Mono",
      cssVariable: "--font-geist-mono",
      provider: fontProviders.google(),
      weights: [400, 500],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      optimizedFallbacks: true,
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
