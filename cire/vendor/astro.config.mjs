import solidJs from "@astrojs/solid-js";
import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

export default defineConfig({
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running
  // `dev:app` directly), where every Astro app would otherwise fight over the
  // default 4321.
  server: { port: devPort(4326) },

  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "static",
  integrations: [solidJs()],

  // Both faces are downloaded at build time and served from our own origin.
  // All three page shells used to <link> fonts.googleapis.com, which cost a DNS
  // lookup, a TLS handshake and a render-blocking round trip to a third party
  // before a single word could paint — and told Google about every vendor who
  // opened the portal, including on the claim page, which is reached from an
  // emailed invite link. Astro's pipeline also emits the preload links and the
  // fallback metrics (`optimizedFallbacks`), so the swap from fallback face to
  // real face doesn't shift the layout.
  //
  // Self-hosting is also what lets `public/_headers` drop both Google origins
  // from `style-src` and `font-src` — the comment there anticipated this.
  fonts: [
    {
      // The portal's whole voice, and the same face the host portal uses. A
      // tool is read as data — enquiry lists, price bands, quote figures — so
      // the UI face is a grotesque with real tabular numerals, not the invite's
      // stationery serif. Lato, which this portal used to load, is the guest
      // site's body face; it has no business here.
      name: "Schibsted Grotesk",
      cssVariable: "--font-ui",
      provider: fontProviders.google(),
      weights: ["400 700"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      optimizedFallbacks: true,
    },
    {
      // Flair only, and rationed: the wordmark, an organisation's name, and the
      // name on a claim invite. Roman only — the portal chrome never sets
      // Cormorant italic (see the `h1..h4` rule in `styles/global.css`), and
      // this portal has no invite preview to need it.
      name: "Cormorant Garamond",
      cssVariable: "--font-flair",
      provider: fontProviders.google(),
      weights: ["300 700"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["Iowan Old Style", "Palatino", "Georgia", "serif"],
      optimizedFallbacks: true,
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
