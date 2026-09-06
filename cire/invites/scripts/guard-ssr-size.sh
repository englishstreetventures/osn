#!/usr/bin/env bash
# Guard the size of the cire/invites SSR Worker bundle.
#
# Tracker #287: this Worker's SSR bundle reached 470 KB gzip unnoticed, from two
# separate mistakes. Three `.motion.ts` modules dragged the whole `motion`
# library into the SSR module graph though nothing there ever ran it (fixed by
# stubbing `motion` out of the SSR build only, see `astro.config.mjs`); and
# three drift-guard tests sat un-prefixed under `src/pages`, so Astro routed
# them, deployed them, and pulled 119 KB gzip of vitest along with them (fixed
# by the `_` prefix Astro's router excludes). This guard measures the same total
# again on every build and fails the moment it grows past a set point, rather
# than the growth being found from a tracker issue months later.
#
# Run from anywhere; it resolves the package directory from its own location.
# Requires an existing `dist/server`, so run it after `astro build`.
set -euo pipefail

pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$pkg_dir"

# `no_bundle: true` (the adapter's generated config) means `wrangler deploy`
# ships every file in `dist/server` as its own module rather than concatenating
# them, so the sum of each file's OWN gzip size is what crosses the wire — not
# the gzip of the directory as a whole. Everything except `wrangler.json` is
# uploaded, so measure exactly that set: matching on `*.mjs` would coincide with
# it today and stop matching the moment the adapter emitted a `.js` chunk, which
# its own generated `rules` already declare as an ES module. `.map` files are
# excluded too: they're uploaded to Cloudflare for symbolication
# (`upload_source_maps` in `wrangler.jsonc`), not part of the script the
# Worker runs, and roughly double the reading if left in.
if [ ! -d dist/server ]; then
  echo "::error::cire/invites dist/server is missing — run \`astro build\` before this guard."
  exit 1
fi

# Source maps belong in `dist/server` and NOWHERE ELSE. `dist/client` is this
# Worker's Static Assets directory (the adapter writes
# `"assets": { "directory": "../client" }` into the generated wrangler config)
# and Cloudflare serves every file there verbatim, so a `.map` that lands in it
# publishes the guest site's unminified source at `/_astro/<chunk>.js.map` to
# anyone who asks. That is exactly what a plain `vite: { build: { sourcemap:
# true } }` does, because the client environment reads the top-level value at
# `astro/dist/core/build/vite-build-config.js:135` — which is why
# `astro.config.mjs` sets `sourcemap` inside the `astro:build:setup` hook
# instead. This check is the tripwire for that mistake coming back.
if [ -d dist/client ]; then
  client_maps=$(find dist/client -type f -name '*.map' | wc -l | tr -d ' ')
  if [ "$client_maps" -ne 0 ]; then
    echo "::error::cire/invites dist/client holds ${client_maps} source map(s). dist/client is served publicly as Static Assets, so these would publish the guest site's unminified source. Scope \`sourcemap\` to the server build (see the minifySsrBuild() comment in astro.config.mjs)."
    exit 1
  fi
fi

total=0
count=0
while IFS= read -r -d '' f; do
  # `-n` keeps the source filename out of the gzip header. Without it the
  # measured total shifts by tens of bytes whenever a chunk is renamed or its
  # content hash changes, so the same build measures differently for no reason.
  size=$(gzip -nc "$f" | wc -c)
  total=$((total + size))
  count=$((count + 1))
done < <(find dist/server -type f ! -name 'wrangler.json' ! -name '*.map' -print0)

if [ "$count" -eq 0 ]; then
  echo "::error::cire/invites dist/server holds no deployable files — the guard measured nothing, which is a broken build, not a pass."
  exit 1
fi

echo "cire/invites dist/server gzip total: ${total} bytes across ${count} files"

# Threshold = the measured total plus headroom for ordinary dependency growth.
# 163317 (measured total, this bundle, after sessions off + SSR minify +
# server-only source maps) + 11683 = 175000.
#
# The headroom is deliberately SMALLER than the mistake this guard exists to
# catch, which is the half the pre-minification threshold got wrong. `motion`
# costs 21261 bytes gzip in the MINIFIED build — measured, not assumed: that is
# the size of its own already-minified client vendor chunk
# (`dist/client/_astro/animate.*.js`), and rebuilding with `stubMotionForSsr()`
# removed moves the server total by the same ~21.4 KB. The old threshold budgeted
# 47657 bytes, motion's cost back when this build was UNMINIFIED, so a fresh
# library of exactly that class would have landed under the line and shipped
# silently. At 11683 bytes of headroom a motion-class mistake overshoots by
# roughly 9.6 KB and fails the build, while ordinary dependency bumps have real
# room to move.
#
# Re-baselining after an intentional change: take the new reading, add the same
# ~11.7 KB, and re-check that the gap to a current library of motion's class is
# still comfortably positive. It does NOT catch a few hundred bytes of ordinary
# bump, and it is nowhere near the Workers Free-tier 3 MB cap — this watches the
# trajectory, it is not a check against the cap.
threshold=175000
if [ "$total" -gt "$threshold" ]; then
  echo "::error::cire/invites dist/server gzip total ${total} bytes exceeds the ${threshold} byte guard (tracker #287). Something is likely pulling a new dependency into the SSR module graph that never runs server-side — check what is newly reachable from a server-side import() or import, the way motion was."
  exit 1
fi
