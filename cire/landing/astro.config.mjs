import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

// Pure static marketing site — serves the apex `cireweddings.com` (domain
// reshuffle 2026-07-16; guest invites moved to `invite.`, organiser to `host.` —
// see [[wiki/apps/cire-landing]]). Unlike the guest site (`cire/invites`, SSR Worker
// — it resolves a wedding per request) the
// landing page is the same for everyone, so it prerenders to plain HTML and
// deploys to Cloudflare Pages (`wrangler pages deploy dist`) exactly like the
// organiser portal. No Cloudflare adapter is needed for a static build.
export default defineConfig({
  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "static",
  // Canonical site origin, baked in for SEO meta (og:url, canonical). Overridden
  // per-environment via the `SITE` build var so the preview deploy advertises its
  // own URL and the apex deploy advertises cireweddings.com.
  site: process.env.SITE ?? "https://cireweddings.com",
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
      // The stationery serif. Same family, same weights as the guest site
      // (`cire/invites`) — the apex and the invite are one brand, and the
      // token comment in `styles/global.css` already says so.
      name: "Cormorant Garamond",
      cssVariable: "--font-cormorant",
      provider: fontProviders.google(),
      weights: [300, 400, 600],
      styles: ["normal", "italic"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["Georgia", "serif"],
      optimizedFallbacks: true,
    },
    {
      // Body copy. 700 is the only weight the legal pages don't use, and it
      // ships anyway because the marketing page sets it.
      name: "Lato",
      cssVariable: "--font-lato",
      provider: fontProviders.google(),
      weights: [300, 400, 700],
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
