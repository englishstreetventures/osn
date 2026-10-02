---
"@cire/build-tools": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
---

The Astro integration that points each build's `_headers` CSP at its own
cire-api now lives once, in the new build-only package `@cire/build-tools`
(`@cire/build-tools/tier-headers`). The organiser portal, the vendor portal and
the guest site each keep only their part in `src/lib/tier-headers.ts`: the env
chain they read and which build output must name the API. The built `_headers`
are unchanged on every tier. The guest site's build log now tags the line with
`cire-tier-headers`, like the portals'.
