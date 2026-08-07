import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

export default defineConfig({
  // Astro 7 changed the default to JSX-style whitespace stripping; pin the
  // Astro 6 behaviour so the upgrade does not change rendered markup.
  compressHTML: true,
  output: "static",
  integrations: [solidJs()],

  // Both faces are downloaded at build time and served from our own origin.
  // The portal used to link fonts.googleapis.com, which cost a DNS lookup, a
  // TLS handshake and a render-blocking round trip to a third party before a
  // single word of a signed-in dashboard could paint — and told Google about
  // every host who opened it. Astro's pipeline also emits the preload links and
  // the fallback metrics (`optimizedFallbacks`), so the swap from fallback face
  // to real face doesn't shift the layout.
  fonts: [
    {
      // The portal's whole voice. A tool is read as data — long guest tables,
      // budget columns, RSVP counts — so the UI face is a grotesque with real
      // tabular numerals, not the invite's stationery serif. This is a
      // deliberate split from the guest site (`cire/invites`), which is
      // Cormorant + Lato throughout: the invite is a printed thing, and the
      // portal is the desk it was made on.
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
      // Flair only, and rationed: the wordmark, a wedding's name, and the
      // invite preview. Italics ship because the preview uses them; the portal
      // chrome never does (see the `h1..h4` rule in `styles/global.css`).
      name: "Cormorant Garamond",
      cssVariable: "--font-flair",
      provider: fontProviders.google(),
      weights: ["300 700"],
      styles: ["normal", "italic"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["Iowan Old Style", "Palatino", "Georgia", "serif"],
      optimizedFallbacks: true,
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
