---
"@cire/invites": patch
---

Cut the guest site's server bundle further, from 285 KB to 163 KB gzip, and re-baseline the size guard.

Trackers #618, #616, #617: three follow-ups from the original SSR bundle-size
audit (tracker #287).

Astro sessions are unused (`Astro.session` is never read or written), so
`astro.config.mjs` now sets `session: false` instead of pinning an in-memory
driver. Astro's session config accepts `false` as a literal, and the
Cloudflare adapter's KV-binding auto-provisioning is gated on that same
literal, so this drops the session runtime and `unstorage` from `dist/server`
without introducing a `SESSION` KV binding (#618).

The SSR build was unminified — Astro's Vite build config hard-sets
`minify: false` for the server build after spreading the user's own `vite.build`,
so the usual `vite: { build: { minify: true } }` config is a no-op there. A
small inline Astro integration hooks `astro:build:setup`, which runs after that
config is built and whose `updateConfig` wins, to force `minify: true` for the
server and prerender builds only — the client build is unaffected (#616).
Because minified output loses source line numbers on a production exception,
this ships with `sourcemap: true` set through that same hook and
`upload_source_maps: true` in `wrangler.jsonc`, so Cloudflare can symbolicate a
crash back to a real source line. Setting `sourcemap` through the hook rather
than as a plain Vite config value is deliberate: the plain form also reaches the
client build, which would emit `.map` files into `dist/client` — the directory
Cloudflare serves as public Static Assets — and publish the guest site's
unminified source. `.map` files are excluded from the size guard (they're
uploaded for symbolication, not part of what the Worker runs), and the guard now
fails outright if any `.map` file appears under `dist/client`.

`zod` was traced (#617): it comes from Astro's own actions request handler
(`actions/handler.js` → `actions/runtime/server.js`, which imports
`zod/v4/core`), invoked on every non-prerendered request regardless of whether
the app defines any actions. This app doesn't, but there's no app-level
config to skip that code path, so `zod` stays — it's a real Astro core
dependency, not dead weight, and it is not stubbed the way `motion` was.

`cire/invites/scripts/guard-ssr-size.sh`'s threshold moves from 310000 to
175000: the new measured total plus about 11.7 KB of ordinary-growth headroom.
The headroom is now deliberately smaller than the mistake the guard is for —
`motion` costs 21261 bytes gzip in the minified build, so a library of that
class overshoots and fails, where the old "measured plus one motion" arithmetic
would have let it through. The guard also excludes `*.map` from the
measurement, fails if any `.map` file appears under the publicly served
`dist/client`, and now runs from the package's own `build` script rather than
only from CI, so the by-hand deploy path is covered too.
