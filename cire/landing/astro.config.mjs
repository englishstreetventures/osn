import solidJs from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Pure static marketing site — serves the apex `cireweddings.com` (domain
// reshuffle 2026-07-16; guest invites moved to `invite.`, organiser to `host.` —
// see [[wiki/apps/cire-landing]]). Unlike the guest site (`cire/web`, SSR Worker
// — it resolves a wedding per request) the
// landing page is the same for everyone, so it prerenders to plain HTML and
// deploys to Cloudflare Pages (`wrangler pages deploy dist`) exactly like the
// organiser portal. No Cloudflare adapter is needed for a static build.
export default defineConfig({
  output: "static",
  // Canonical site origin, baked in for SEO meta (og:url, canonical). Overridden
  // per-environment via the `SITE` build var so the preview deploy advertises its
  // own URL and the apex deploy advertises cireweddings.com.
  site: process.env.SITE ?? "https://cireweddings.com",
  integrations: [solidJs()],
  vite: {
    plugins: [tailwindcss()],
  },
});
