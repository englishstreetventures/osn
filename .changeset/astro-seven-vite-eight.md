---
"@osn/landing": patch
"@pulse/landing": patch
"@pulse/app": patch
"@osn/ui": patch
"@osn/social": patch
---

Astro 7 + vite 8 migration: `astro ^6.4.6 → ^7.1.1`, `@astrojs/solid-js ^6.0.1 → ^7.0.1` (all astro sites), `@astrojs/cloudflare ^13.7.0 → ^14.1.3` (guest site). Clears the three astro XSS advisories (GHSA-4g3v-8h47-v7g6, GHSA-f48w-9m4c-m7f5, GHSA-7pw4-f3q4-r2p2). Root `vite` override raised `^7.3.5 → ^8.0.13` (astro 7 requires vite 8) with workspace devDeps restored to `^8.0.13`, and the `esbuild` override floor raised `^0.25.0 → ^0.27.0`. `compressHTML: true` pinned in all astro configs to preserve Astro 6 whitespace output.
