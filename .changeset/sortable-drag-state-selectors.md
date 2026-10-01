---
"@shared/sortable": minor
---

Add `dragging` and `isDragged(id)` to the drag state, and stop rows from re-running their drag computations on every slot the pointer crosses.

`active()` changes on pick-up, on every slot change and on drop, so a row that styled itself by `!!active().draggable` re-ran its effect once per slot crossed — on a 500-row list, 500 re-runs per slot. `dragging()` is one memo per provider and changes only when a drag starts or ends. `createSortable`'s `isActiveDraggable` now reads a selector over the dragged id, so only the row whose answer flips wakes. Each row's shift is kept per key, so a slot change re-runs only the rows whose shift changed, and `transform` compares by value, so a row that stays put does not repaint.
