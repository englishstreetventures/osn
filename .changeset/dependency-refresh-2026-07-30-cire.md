---
"@cire/api": patch
"@cire/db": patch
"@cire/invite-designs": patch
"@cire/landing": patch
"@cire/organiser": patch
"@cire/vendor": patch
"@cire/web": patch
---

Refresh dependencies across the cire stack as part of the monorepo-wide
maintenance audit — `astro` 7.1.1 → 7.1.3, `@astrojs/cloudflare` 14.1.3 → 14.1.4
(fixes an Actions dev-server crash and an over-ridden `cache: { enabled: false }`
in wrangler config), `tailwindcss` 4.3.0 → 4.3.3, `wrangler` 4.100 → 4.114,
`miniflare` → 4.20260722.0, `vitest` → 4.1.10, `solid-js` 1.9.13 → 1.9.14, and
`effect` 3.21.2 → 3.22.0.

All patch/minor bumps; no breaking changes or migration steps.
