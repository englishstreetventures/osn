---
"@cire/landing": patch
---

Self-host Cormorant Garamond and Lato instead of linking `fonts.googleapis.com`.

Astro's font pipeline (`fontProviders.google()` in `astro.config.mjs`) downloads
both faces at build time, serves them from our own origin, emits the preload
links, and generates the metric-matched fallbacks — so the swap from fallback to
real face no longer shifts the layout. Only the latin and latin-ext subsets ship.

This removes the last render-blocking third-party request from the marketing
site, and with it the transmission of every visitor's IP and user-agent to
Google LLC (US) — which no consent gate covered, because the `<link>` sat in the
server-rendered `<head>`. `public/_headers` drops both Google origins from
`style-src` and `font-src`, and a new test asserts they stay gone.

The two font tokens in `styles/global.css` are no longer byte-identical with
`cire/invites` — both self-host the same two families at the same weights, by
different routes. The comment there says so.
