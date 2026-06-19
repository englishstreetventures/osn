---
"@cire/web": patch
---

Add a Content-Security-Policy (and re-assert the other security headers) to the
guest site via Astro SSR middleware.

`cire/web` is an SSR Worker (`@astrojs/cloudflare`, `output: "server"`), not a
Pages site. Cloudflare Workers Static Assets honours `public/_headers`, but only
for the **static-asset layer** (the prerendered `/privacy` + `/terms` pages and
`/_astro/*`) — NOT the Worker-rendered invite routes (`/<slug>`, the bare-domain
`/` redirect). So the existing `_headers` security headers were never applied to
the actual invite pages. New `src/middleware.ts` (`onRequest`) attaches the full
header set to every SSR response, built from a structured directive map in
`src/lib/security-headers.ts`; `public/_headers` is kept in sync for the static
paths.

The CSP allowlist is derived from an audit of the guest site's real external
origins: Pinterest moodboard widget (`assets.pinterest.com` script,
`widgets.pinterest.com` connect, `i.pinimg.com` img, board iframe), Google Maps
Embed (`www.google.com` frame + `maps.gstatic.com`/`maps.googleapis.com` img),
Google Fonts (`fonts.googleapis.com` style + `fonts.gstatic.com` font),
Cloudflare Turnstile (`challenges.cloudflare.com` script + frame), and the
first-party cire-api (`api.cireweddings.com` img + connect). `frame-ancestors
'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` are locked
down. `script-src` stays host-restricted (no wildcard) but keeps `'unsafe-inline'`
because Astro's island hydration emits inline `<script>` blocks and the font
preload uses an inline `onload` handler (neither hash-eligible from a single
response header); `style-src`/`style-src-attr` keep `'unsafe-inline'` for the
invite's inline theme style attributes. Wants a real-browser smoke test on the
deployed site before being fully trusted.
