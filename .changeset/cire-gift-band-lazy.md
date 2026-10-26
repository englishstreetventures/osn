---
"@cire/invites": patch
"@tools/e2e": patch
---

- `@cire/invites`: the invitation's gift band island now holds only the gift-list read. The band and the gift-list client download the first time that read answers with a list, so a guest of a wedding without one (below Gold, unpublished, or none) never downloads them: 2,334 B gzip less on each design pack's invitation. A Gold wedding's guests fetch the band as a second chunk. The read and the list's types move to `src/lib/gift-registry-read.ts`; `GiftRegistryTeaserIsland` is the island both packs mount, and `GiftRegistryTeaser` is the band alone. The server build leaves the band out, since it never renders it.
- `@tools/e2e`: `cire-rsvp-after-deadline` opens the Ivory sample wedding's invitation in a second tab and checks the list read answers 404 and the tab never requests the band's module or the gift-list client; `cire-registry-claimed` checks the Gold wedding's invitation requests both.
