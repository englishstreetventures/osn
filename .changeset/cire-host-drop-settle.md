---
"@cire/host": patch
---

A row dropped in any sortable list (events, run of show, gift list, checklist,
budget, FAQ, seating's tables) now settles into its slot instead of jumping, as
`DESIGN.md` §4 now states. A browser test drags a list with a real pointer and
checks the settle's first frame, its timing, its stacking, its end, the
reduced-motion and cancel paths, a drag that catches a settling row, and that a
keyboard move does not animate.
