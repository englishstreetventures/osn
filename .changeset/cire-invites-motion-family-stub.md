---
"@cire/invites": patch
---

Stub `framer-motion` out of the guest site's server build, along with `motion`, `motion-dom` and `motion-utils`. `motion`'s own entry re-exports `framer-motion/dom`, so a direct import of it would have walked past the stub and put about 21 KB gzip back into the Worker. The Vite plugin moves from `astro.config.mjs` to `src/lib/stub-motion-for-ssr.ts`, where a unit test calls it directly. The built Worker does not change.
