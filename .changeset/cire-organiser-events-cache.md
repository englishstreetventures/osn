---
"@cire/organiser": patch
---

Stop the organiser dashboard re-fetching events on every tab switch.

The dashboard tabs render each panel behind a `<Show>`, so flipping Guests ↔
Events unmounted and remounted `EventTable` — and its `onMount` fetch re-fired
`GET /api/organiser/weddings/:weddingId/events` on every flip back to Events.

- New `cire/organiser/src/lib/events-store.ts` — a small module-scoped,
  `weddingId`-keyed cache (plain Solid signals, no Effect, no state library).
  Each wedding's events are fetched at most once and reused across `EventTable`
  remounts; reads are reactive so an in-place image/crop patch updates every live
  mount and survives a tab switch without a refetch.
- `EventTable.tsx` now reads/writes through the cache: a cache hit on mount skips
  the network round-trip entirely (and paints rows immediately, no skeleton);
  image upload/remove/crop patches go through `patchCachedEvent`. Loading/error
  UI and the 401 / auth-expiry redirect behaviour are unchanged.
- **Invalidation rules:** a different `weddingId` is a different cache key, so
  switching weddings refetches; an import apply calls `invalidateEvents(weddingId)`
  (in `ImportPanel`) so newly imported events show on the Events tab's next mount.

Tests: new EventTable coverage proving the events fetch is NOT re-issued on a tab
switch back (single queued response, `authFetch` call count stays at 1), and that
it DOES refetch on a wedding change and after an import-apply invalidation. 147
organiser tests green.
