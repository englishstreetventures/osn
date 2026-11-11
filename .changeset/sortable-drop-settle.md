---
"@shared/sortable": patch
---

A list row let go by a pointer now eases from where it was released into its
slot, instead of jumping there, on the app's `--dur-base` and `--ease-out`
(falling back to `--ui-dur-base` and `--ui-ease-out`). A cancelled drag eases
the row back to the slot it left. Under `prefers-reduced-motion: reduce` the row
lands at once, keyboard moves do not animate, and free items do not settle. A
new drag ends any settle before it measures the list, and one that catches the
settling row picks it up where it is.

`isActiveDraggable()` on a list row now stays true until the row has landed, so
a row's lifted look lasts as long as it moves. The provider writes no stacking
of its own: a lifted look should carry a `z-index`, or a settling row passes
under a later neighbour that is positioned.
