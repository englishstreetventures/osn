---
"@cire/organiser": patch
---

Collapse the invite builder's section tabs into a menu on phones.

The builder's eight section tabs can't share a line below `@3xl/builder`
(48rem), and the row was `overflow-x-auto` — so on a phone Closing and Message
sat off the right edge with nothing to say so, the same failure the module strip
had before it became a sheet.

Below that threshold the tabs now collapse behind a trigger naming the current
section — its label, its `n/8` position and its Shown/Hidden dot, so the menu
only has to be opened to move, never to orient — which opens them as a
two-column grid: all eight on screen at once (≈206px tall on a 390px phone, so
nothing scrolls), 44px touch targets, positioned against the sticky bar so
opening it overlays the form rather than shoving it down. From `@3xl/builder` up
the trigger is `display: none` and the tabs are the same static row as before.

It re-lays-out the SAME `role="tablist"` rather than rendering a second copy of
the tabs: each section panel's `aria-labelledby` points at `${id}-tab`, so a
duplicate would give every panel two candidate labels and assistive tech two
tabs widgets.

Four things dismiss the menu: a selection (which hands focus back to the
trigger, since collapsing takes the focused tab to `display: none` and focus
with it), `Escape`, an outside press, and **focus leaving the nav** — that last
one because the menu is an opaque overlay across the top of the active section,
so tabbing forward instead of selecting used to land focus in a form control the
organiser could no longer see, with no keyboard way to uncover it. The observer
that already picks the preview layer also collapses the menu when the container
grows past the threshold, so a menu opened on a phone can't survive a rotate and
start dropping focus on wide tab clicks.

`ArrowDown`/`ArrowUp` work only while the menu is open — on the wide single-line
row they belong to the browser, and handling them there swallowed page scroll —
and they step by the grid's column count, so "down" is the item below rather
than the one to the right. The trigger's accessible name carries the
Shown/Hidden state as a clause, since its dot is `aria-hidden` and an
`aria-label` would override any `sr-only` text.

Twelve tests cover the trigger's live naming and state, the collapse, all four
dismiss paths, the crossover collapse, both arrow contracts, and the
single-tablist invariant.
