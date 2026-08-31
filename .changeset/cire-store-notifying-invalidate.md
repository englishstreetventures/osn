---
"@cire/host": patch
---

Fix `invalidateXxx` across seven organiser-portal caches (events, guests,
households, enquiries, vendors, budget, tasks) so a mounted view actually
notices. Each one used to `cache.delete(weddingId)`, which drops the map
entry but leaves any signal a component already captured on mount pointing
at a spot nothing writes to again — the view keeps showing stale rows
forever, and the next `ensureXxxLoaded` call quietly builds a *new* signal
that only a fresh mount would read. `invalidateXxx` now writes `null`
through the existing signal instead, so every mounted consumer observes the
transition, `hasCachedXxx` reports false, and a stale fetch that was still
in flight at invalidate time can no longer land its result afterwards (each
store already guarded this with a per-wedding generation counter; the four
Group 1 stores — enquiries, vendors, budget, tasks — gain that same counter
here, matching the three that already had it).

Also corrects two stale doc claims: the sibling-store list in
`registry-store.ts`'s file docblock, and `EnquiriesView.tsx`'s comment
claiming invalidation could not refresh the inbox.
