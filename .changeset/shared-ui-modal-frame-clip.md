---
"@shared/ui": patch
---

`Modal`'s `frame` panel now clips instead of hiding.

`overflow: hidden` refuses the user a scrollbar and grants everything else: `scrollIntoView`, and the scroll the platform performs when focus lands on a descendant it believes sits outside the box. A dialog that accepts that slides sideways and never slides back. `overflow: clip` is not a scroll container and has no scroll offset to move.

Both axes have to say `clip` — beside an `auto` axis, `clip` computes to `hidden` (CSS Overflow 3 §3.1) and buys nothing. A browser-tier test asserts the computed pair and that a `scrollIntoView` on an out-of-panel descendant leaves the dialog where it was.
