---
"@shared/sortable": minor
---

Add `@shared/sortable` — internal drag-to-reorder for SolidJS, replacing
`@thisbeyond/solid-dnd` (last released November 2023).

The API mirrors what it replaces — `DragDropProvider`, `DragDropSensors`,
`SortableProvider`, `createSortable`, `closestCenter`, `maybeTransformStyle`,
`useDragDropContext` — so adopting it is an import swap. One difference:
`transform`, `isActiveDraggable` and `active` are accessors rather than store
properties, so call them.

Two things the replaced library could not do:

- **`createSortableList` owns the keyboard and screen-reader path.** solid-dnd
  shipped a pointer sensor and nothing else, so every list that wanted dragging
  had to hand-write ~120 lines of it — which is why three lists in the organiser
  portal never adopted drag and said so in code. The package now carries all five
  obligations, with tests: a real `<button>` grip owning the arrows with
  `preventDefault` before the bounds check, `sr-only` move buttons for browse
  mode, explicit focus restore after a keyboard move, a live region that clears
  before it sets, and auto-repeat ignored. Hint ids are generated per list rather
  than hardcoded, so several lists can share a page.
- **Multi-container.** Items register with the `SortableProvider` they sit under,
  and collision detection never crosses a group — so N lists on a page are N
  independent sortables. Deliberately not cross-container: moving an item between
  lists is a re-bucketing, not a re-order.

The pointer sensor has a distance activation threshold, so a press that never
moves leaves the order untouched — without it, every click on a handle that is
also a button would commit a move.
