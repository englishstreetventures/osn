---
"@cire/host": patch
---

A row dropped in any sortable list (events, run of show, gift list, checklist,
budget, FAQ, seating's tables) now settles into its slot instead of jumping,
and keeps the look it was dragged in until it lands, as `DESIGN.md` §4 now
states. A browser test drags a list with a real pointer and checks the settle's
first frame, its timing on the app's tokens and on the shared ones, its look and
stacking, its end, the reduced-motion and cancel paths, a drag or a press that
catches a settling row, a drag of another row mid-settle, the real budget list,
and that a keyboard move does not animate. The seating test checks that a
dropped guest does not settle.
