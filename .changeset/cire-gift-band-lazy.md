---
"@cire/invites": patch
"@tools/e2e": patch
---

- `@cire/invites`: the invitation's gift band island now holds only the gift-list read. The band and its display helpers download the first time that read answers with a list, and the client that claims, releases and gives is not part of the invitation at all. A guest of a wedding without a list (below Gold, unpublished, or none) downloads 2,329 B gzip less on each design pack's invitation; a Gold wedding's guests 656 B less, the band arriving as a second request. The read and the list's types are in `src/lib/gift-registry-read.ts`, the shared display helpers in `src/lib/gift-registry-display.ts`; `GiftRegistryTeaserIsland` is the island both packs mount, and `GiftRegistryTeaser` is the band alone. The server build leaves the band out, since it never renders it.
- `@tools/e2e`: `cire-rsvp-after-deadline` opens the Ivory sample wedding's invitation in a second tab and checks the list read answers 404 and the tab requests none of the gift list's band, display or client modules; `cire-registry-claimed` checks the Gold wedding's invitation requests the band and its display helpers, and not the client.
