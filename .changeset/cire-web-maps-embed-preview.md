---
---

cire/web: render a real Google Maps Embed preview in the event-details "Where"
section when a key is configured, with the existing CSS-drawn map card as the
fallback.

`MapPreview.tsx` now reads `PUBLIC_GOOGLE_MAPS_EMBED_KEY` (build-time, baked into
the static Astro output). When the key is present **and** the event has a venue
address, it renders a Google Maps Embed API `place` iframe queried by the free-text
address (`q=`) — free, unlimited, no coordinates, no geocoding, no schema change.
When the key is unset/blank, or the event has no address to query, it falls back to
today's CSS-drawn cartographic card, so the page never breaks and the feature is a
pure enhancement that ships safely before any key exists.

- Security: the address is the only interpolated value and is always
  `encodeURIComponent`-escaped via the new `resolveMapsEmbedUrl` helper in
  `event-details.ts`; organiser text never reaches the iframe URL/DOM unescaped.
  The key is never logged and is meant to be referrer-restricted at the Maps
  Platform console (documented).
- a11y/perf: the iframe has a meaningful `title` ("Map of <venue>"),
  `loading="lazy"`, and a fixed height matching the card so it causes no layout
  shift. The "Open in Maps" action keeps working in both modes.
- Hardening (review S-L1/S-L2): the iframe is sandboxed
  (`allow-scripts allow-same-origin allow-popups` — no top-navigation/forms) and
  uses `referrerpolicy="strict-origin-when-cross-origin"`, matching the page-level
  referrer policy so the slug-/`?code=`-bearing invite path is never leaked to
  Google (only the origin, which the key restriction needs, is sent).
- Docs: `PUBLIC_GOOGLE_MAPS_EMBED_KEY` added to `cire/web/.env.example` and to the
  production-deploy runbook §3.3 (optional; human step is to create a
  referrer-restricted, Maps-Embed-only key).

`@cire/*` packages are version-less/ignored by changesets, so this is an empty
changeset.
