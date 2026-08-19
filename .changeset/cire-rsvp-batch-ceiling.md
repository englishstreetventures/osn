---
"@cire/api": patch
---

Chunk the RSVP write set under D1's per-batch statement ceiling.

`submitRsvps` built one write set and committed it unchunked, but the endpoint
accepts up to 200 RSVPs and D1 rejects a batch over 50 statements — so a large
household submit answered 500. It now commits through `commitGroupedBatches`
with one singleton group per upsert: each upsert is independent and idempotent
on `(guestId, eventId)`, so giving up whole-set atomicity beyond the ceiling
costs nothing a retry can't fix. The 200 cap is unchanged. Covered by a
Miniflare (`test:d1`) case submitting 51 pairs — one over the ceiling — since
the bun:sqlite fallback commits sequentially and cannot fail this way. P-W2.
