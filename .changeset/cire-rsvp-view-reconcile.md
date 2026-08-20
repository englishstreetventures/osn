---
"@cire/host": patch
---

Reconcile the RSVP list on reload instead of replacing it.

`RsvpView`'s `load()` re-fetched `/rsvps` after every save and swapped the
whole events array, so saving one guest's reply threw away every event and
row object in the wedding and forced `<For>` to rebuild the entire table —
the exact rebuild the row memos existed to avoid, paid on every save.

The events list now lives in a `createStore`, reconciled by `id` on reload
so an untouched event keeps its object identity. That alone isn't enough:
a whole-list memo still re-merges every event's rows on any nested change.
Row merging and filtering are now scoped per event via `createMemo(mapArray(...))`,
so only the event whose own guests changed re-runs its row/visibility memos —
the rest keep their row array identity and `<For>` patches in place rather
than remounting.

Reactivity-only change: no behaviour, markup, ARIA, or copy moved. Adds a
test asserting a row in an untouched event is the same DOM node across a
save-and-reload, while the changed event's row updates.
