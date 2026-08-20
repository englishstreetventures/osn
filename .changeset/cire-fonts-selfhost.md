---
"@cire/invites": patch
---

Self-host the invite typefaces instead of loading them from `fonts.googleapis.com`.

Cormorant Garamond and Lato now ship via `@fontsource/cormorant-garamond` and
`@fontsource/lato`, bundled and served from the app's own origin. This drops a
third-party connection from the guest critical path and removes the preconnect
+ preload + `onload` swap dance from all four document shells. Metric-matched
`@font-face` fallbacks (computed from `@capsizecss/metrics`) keep the layout
stable while the real faces load, instead of reflowing the hero title on swap.
The CSP `style-src`/`font-src` and the Google Fonts consent-vendor entry are
gone with the origins they existed for; the woff2 files land under the
content-hashed `/_astro/*` path and are cached immutably.

Only the latin and latin-ext subsets are shipped, and each rule points at the
`.woff2` alone. Pulling in fontsource's whole-family entrypoints instead would
put 49 `@font-face` rules on the render-blocking critical path — every subset
of both families, plus a legacy `.woff` per rule small enough that the bundler
base64-inlined eight of them into the stylesheet. Names in Cyrillic or
Vietnamese now paint in the metric-matched fallback by design.
