---
"@cire/web": patch
---

Centralise the guest site's z-index stacking order into a single source of
truth (`src/lib/z-index.ts`).

Previously `AnimatedModal` hardcoded `z-100` and the `AddToCalendar` popover
hardcoded `z-110` with no shared constant enforcing their relative order — the
exact gap that let #203 ship (the popover at `z-90`, *below* the modal it
launches from, so it rendered behind the modal backdrop and looked broken).

A new module exports a `Z_LAYER` scale (`BASE` 0 / `EVENT_CARD` 10 / `MODAL`
100 / `MODAL_POPOVER` 110) and matching `Z_CLASS` Tailwind class literals
(`z-0` / `z-10` / `z-100` / `z-110`). `AnimatedModal` and `AddToCalendar` now
consume `Z_CLASS.MODAL` / `Z_CLASS.MODAL_POPOVER` instead of magic numbers, so
the ordering is defined in one place. The invariant "a popover launched from
inside a modal must sit ABOVE that modal" (`MODAL_POPOVER > MODAL`) is
documented in the module and asserted by a unit test, so this class of bug
can't recur unnoticed. Pure refactor — the on-screen stacking values
(modal=100, popover=110) are unchanged.
