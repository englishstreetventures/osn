---
"@osn/landing": patch
"@pulse/landing": patch
"@pulse/web": patch
---

Self-host the typefaces instead of linking `fonts.googleapis.com`.

`@osn/landing` (Inter, Space Grotesk) and `@pulse/landing` (Geist, Geist Mono,
Instrument Serif) use Astro's font pipeline: `fontProviders.google()` downloads
each face at build time, serves it from our own origin, emits the preload links,
and generates the metric-matched fallback so the swap does not shift layout.
Both drop the Google origins from `style-src` and `font-src` in
`public/_headers`, and both gain a test asserting they stay gone.

`@pulse/web` is SolidStart, which has no equivalent pipeline, so its faces are
written out in `src/app.css` over `@fontsource` — latin and latin-ext only, and
`.woff2` only. Importing fontsource's whole-family entrypoints instead would
have put every published subset on the critical path (Geist Mono ships six) and
let Vite base64-inline the sub-4 KB legacy `.woff` files straight into the
stylesheet.

This removes the last render-blocking third-party request from all three, and
with it the transmission of every visitor's IP and user-agent to Google LLC (US)
— which no consent gate covered, because the `<link>` sat in the server-rendered
`<head>`.
