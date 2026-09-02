---
"@cire/invites": patch
---

Cut the guest site's server bundle from 470 KB to 290 KB gzip, and stop
deploying its tests as live routes.

Tracker #287: `dist/server` (the SSR Cloudflare Worker) had grown to 470 KB
gzip from two unrelated mistakes.

`motion` was the first. Three `.motion.ts` modules — `Modal.motion.ts`, and
each design pack's `UnlockReveal.motion.ts` — only ever call it from a
client-side `onMount` prefetch hint or a DOM event handler, but Vite's SSR
build still walks and bundles every module reachable via `import()`. The whole
library shipped server-side with nothing there ever calling it. A Vite plugin
in `astro.config.mjs` now stubs the `motion` specifier out of the SSR module
graph only; the client build is untouched, so both design packs animate exactly
as before.

The three drift-guard tests were the second, and the larger one. Astro routes
every file under `src/pages`, so `index.test.ts`, `legal-pages.test.ts` and
`[slug]/registry.test.ts` were built and deployed: `/index.test`,
`/legal-pages.test` and `/<slug>/registry.test` answered as real routes on the
guest site, and the vitest they import was a 534 KB (119 KB gzip) chunk in the
Worker — 28% of the bundle.
Each is now `_`-prefixed, which is what excludes a file from Astro's router.
They stay beside the `.astro` file they read and vitest still collects them.

A guard script, `cire/invites/scripts/guard-ssr-size.sh`, measures the same
total — the gzip size of every deployable file in `dist/server`, summed,
because `no_bundle` ships each chunk as its own module — and fails if it passes
310 KB. It runs on every pull request as well as on both deploy jobs, so a
regression is refused at the merge gate rather than found in a size audit
months later.
