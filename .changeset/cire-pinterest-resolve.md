---
"@cire/api": patch
"@cire/web": patch
---

Make Pinterest moodboards actually embed, and move the fallback link below the
embed.

Root cause: the guest board widget (`pinit_main.js`) can only render a full
`pinterest.com/<user>/<board>` URL, never a `pin.it` short link — but real
organiser data is almost always pasted as a `pin.it/...` link, so the embed
never rendered and guests only ever got the link-out.

- `@cire/api`: resolve `pin.it` short links to their canonical board URL ONCE,
  server-side at CSV import apply time, and persist that into `events.pinterest_url`.
  New `services/pinterest-resolve.ts` splits a pure, unit-tested
  `canonicalizePinterestBoardUrl` (resolved location → canonical
  `https://www.pinterest.com/<user>/<board>/`, all tracking params stripped, single
  pins / profiles / non-pinterest hosts rejected) from the network `resolvePinUrl`.
  SSRF-guarded: only `pin.it` / `www.pin.it` inputs are ever fetched, only a
  pinterest.com final host is accepted, redirect depth is capped (≤5) with a short
  AbortController timeout, and ANY failure/timeout/non-board result falls back to
  the original URL unchanged — resolution never blocks or throws out of the import.
- `@cire/web`: the desktop "View moodboard on Pinterest ↗" fallback link now
  renders BELOW the embed/consent block instead of above it. Consent gate,
  success-detection MutationObserver, and failure-timeout logic are unchanged;
  the mobile link-out card is unchanged.

Ops: pin.it resolution happens at import time, so the LIVE wedding's existing
events keep their original `pin.it` URLs until re-imported. Re-run the organiser
spreadsheet import (or re-resolve the stored `pinterest_url`s) to apply canonical
board URLs and light up the embeds for already-imported events.
