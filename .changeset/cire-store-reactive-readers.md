---
"@cire/host": patch
---

Fix the organiser stores' reactive readers so they actually are reactive.
`vendorCount`, `openTaskCount` and `taskCounts` read `cache.get(weddingId)?.xxx()`,
so from a cold cache the optional chain short-circuited before the signal's
accessor was ever called, and a tracking computation built on any of them
registered zero dependencies and never re-ran once the load resolved. The
Overview's vendor-count widget stuck on `Loading your vendors…` for the life of
the page: `Overview.tsx` memoises `vendorCount` at setup, before any fetch has
resolved, so the memo captured `null` with no dependencies and nothing could
make it recompute. The other two carried the identical defect without being
reachable — `taskCounts` is only read inside a `<Show>` nested under the
dashboard's own `!data.loading` gate, and `ensureTasksLoaded` is awaited in the
same `Promise.all` that gate waits on, so the entry always exists by the time
that read first happens; `openTaskCount` has no caller at all. They are fixed
because a non-subscribing reader is one call site away from being the vendors
bug again, not because they are currently broken on screen.

All three now mint the wedding's cache entry on read, exactly as
`spentSoFar`/`upcomingPayments` already do, so they subscribe from a cold
cache too. `peekCachedXxx` and `hasCachedXxx` are unchanged behaviourally, but
now carry an accurate docblock instead of the false "non-reactive" or "without
subscribing" claims some of them shipped with.

`ensureXxxLoaded` now resolves `Promise<boolean>` instead of `Promise<void>`
in all eight stores, so a caller can tell a generation-discarded load (which
still fulfils, since nothing failed) apart from one that actually left the
cache fresh. This is additive — no existing call site reads the resolved
value yet.

`upsertCachedEnquiry` is now a no-op against a `null` (not-loaded) cache
instead of treating it as an empty list. The reachable path predates
invalidation entirely: `EnquireDialog` (mounted from `DirectoryBrowseView` and
`VendorsView`, neither of which ever loads the enquiries cache) upserts
against a stone-cold cache, and writing `[next]` there used to collapse an
organiser's whole inbox to the one just-sent enquiry and permanently suppress
the refetch that would have restored the rest.

Finally, every `invalidateXxx`'s comment now explains why dropping the
in-flight slot is the right trade (one extra request, rather than joining a
fetch whose result the generation guard is about to discard), and
`invalidateRegistry`'s docblock drops its reference to the now-deleted
`cire/wiki/todo/perf` page.
