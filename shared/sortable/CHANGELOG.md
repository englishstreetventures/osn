# @shared/sortable

## 0.1.0

### Minor Changes

- 46204b2: Add `@shared/sortable` — internal drag-to-reorder for SolidJS, to replace
  `@thisbeyond/solid-dnd` (last released November 2023). No consumer uses it yet;
  the migration follows.

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
    before it sets, and auto-repeat ignored. Hint ids are generated per list, so
    several lists can share a page.
  - **Multi-container.** Items register with the `SortableProvider` they sit under,
    and collision detection never crosses a group. Deliberately not
    cross-container: moving an item between lists is a re-bucketing, not a
    re-order.

  Geometry is measured **once, at drag start**. Layout cannot change during a drag
  except for the transforms this package writes, and those are exactly what must be
  excluded — a live read let the dragged row's own offset corrupt the stride, and
  let the detector see displaced rows in the slots they were moving _to_. It also
  keeps the cost flat: at 500 rows a per-event sweep is ~30–60k
  `getBoundingClientRect()` per second, each behind a forced style flush.

  The gesture owns its listeners: pointer capture so a release outside the window
  still ends the drag, a `pointerId` guard so a second touch cannot drive another
  finger's gesture, and an `onCleanup` so an unmount mid-drag tears them down.
