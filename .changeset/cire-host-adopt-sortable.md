---
"@cire/host": patch
---

Move `EventsEditor` onto `@shared/sortable` and drop `@thisbeyond/solid-dnd`.

The drag behaviour is unchanged — all 18 reorder tests pass — but the keyboard,
screen-reader and announcement layer now comes from `createSortableList` instead
of being hand-written in the component, which is 89 lines lighter for it. Haptics
stay here: the package reports drag phases and the portal decides what they feel
like.

That also unblocks `ChecklistView`, `BudgetView` and `RegistryView`, which stayed
on arrow buttons precisely because adopting drag meant re-supplying the whole
keyboard path by hand. Each is now a UX decision rather than an accessibility
project, and each is its own follow-up.

Two fixes fell out of the swap: the grip's `aria-describedby` target id is
generated per list rather than the hardcoded `"reorder-hint"` (which would
collide the moment a second sortable list appeared on the page), and the row's
drag offset is now applied from a called accessor — passing it uncalled painted
`translate3d(undefinedpx, …)`, so the row never moved under the pointer while
every drop-semantics test stayed green.
