---
"@cire/host": patch
---

Fix `invalidateXxx` across eight organiser-portal caches (events, guests,
households, enquiries, vendors, budget, tasks, registry) so a mounted view
actually notices. Seven of them used to `cache.delete(weddingId)`, which drops
the map entry but leaves any signal a component already captured on mount
pointing at a spot nothing writes to again — the view keeps showing stale rows
forever, and the next `ensureXxxLoaded` call quietly builds a *new* signal that
only a fresh mount would read. `invalidateXxx` now writes `null` through the
existing signal instead, so every mounted consumer observes the transition and
`hasCachedXxx` reports false.

A stale fetch that was still in flight at invalidate time can no longer land its
result afterwards either: five stores (enquiries, vendors, budget, tasks and
`registry-store.ts`, which already notified but had no such guard) gain the
per-wedding generation counter the other three already carried.

Also corrects two stale doc claims: the sibling-store list in
`registry-store.ts`'s file docblock, and `EnquiriesView.tsx`'s comment claiming
invalidation could not refresh the inbox.
