---
"@cire/invites": patch
---

The event sheet keeps one height

On the guest invite, the event sheet no longer changes height when the guest
moves between the details and the RSVP form, by the badge or by a swipe. It is
85% of the screen on a phone, and on a larger screen 85% of the window, at
most 760px tall. Content taller than the sheet scrolls inside it.

The sheet also stays still while the guest answers. Choosing "Attending" adds
the dietary and plus-one questions inside the sheet instead of making it
taller. The Cancel and Save bar sits on the sheet's bottom edge however short
the form is, including while a swipe is bringing the form in.

A sparse event now shows empty space below its details.
