---
"@cire/invites": patch
---

P-W1 (cire) — the invite page's post-claim UI is no longer in its initial chunk.
Both design packs statically imported `RsvpModal`, `DetailsModal`, `EventCard`,
`PulseAccountLink` and `AuthProvider`, none of which render until the guest has
claimed a code, so Rollup collected them into the page's eager shared chunk —
about 14 kB gzipped that every guest downloaded and parsed while still looking
at the hero, competing with the preloaded hero image for a 4G connection.

They are `lazy()` now, each subtree behind a `<Suspense fallback={null}>`, and
`onMount` warms the split-out chunks at idle through the existing
`prefetchOnIdle` idiom (via `lazy`'s own `preload()`), so the modal open does
not pay for the smaller first paint. The invite page's eager JS drops from
43.7 kB to 29.5 kB gzipped on the classic pack and from 43.9 kB to 29.3 kB on
gala (measured over each island entry's static-import closure). `Toaster` stays
eager on purpose: it mounts at the page root, and that placement is the fix for
the toast painting behind the RSVP sheet.
