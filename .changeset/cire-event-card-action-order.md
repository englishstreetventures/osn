---
"@cire/invites": patch
---

Put "Event Details" before "Respond" on the invite's event cards.

Respond was the first button in the row and so the first tab stop. The guest now
reads "Event Details" first and answers on the right. Swapped in the DOM rather
than with an `order-*` class, so the tab order follows the visual order instead
of contradicting it.

Nothing else in the row moves: Respond is still the only filled button, still
drops to the outlined treatment rather than a dim one once RSVPs close, and
still points `aria-describedby` at the deadline notice.

Both design packs render the same card, and each pack's tests now assert the
order. A browser-tier test measures the painted row at two widths — sharing one
line, and wrapped, which on the classic pack is what a desktop card does once
the root font-size steps up at 1024px.
