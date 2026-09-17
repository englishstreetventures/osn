---
"@shared/toast": minor
---

`Toaster` can raise itself into the top layer

A `showModal()` dialog paints above every stacking context in the document, so
once an app has one — and `@shared/ui`'s `Modal` is one — no `z-index` on the toast
container can put a toast over it. cire's RSVP save toast fires while the sheet
is still open for its dwell, which is exactly that case: it was raised behind
the reply it confirms.

`topLayer` makes the container a `popover` and shows it whenever there is a
toast to show, so it enters the top layer *after* any dialog that was already
open — top-layer order is entry order. Off by default: it changes how the
container is painted and an app with no top-layer dialogs gains nothing.

It buys paint, not reach. A modal dialog makes every node outside it inert and
the top layer is no exemption, so while one is open the toast is seen and
nothing more — its close button does not respond and assistive technology does
not announce it. A toast raised over a modal has to be a confirmation the dialog
itself also states.
