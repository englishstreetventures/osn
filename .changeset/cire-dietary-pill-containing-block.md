---
"@cire/ui": patch
"@cire/invites": patch
"@cire/landing": patch
---

Stop a dietary pill from sliding the RSVP sheet sideways, and open the "Anything else" field on a transition.

Each preset pill hides a real checkbox behind `sr-only`, which is `position: absolute`. The pill itself was not positioned, so that input resolved against the nearest positioned ancestor — the `<dialog>`, outside the pill track. It therefore did not travel with the track's sideways scroll, and clicking a pill after scrolling asked the browser to bring focus to a box it believed sat hundreds of pixels outside the sheet. The browser obliged by scrolling the dialog. Measured before the fix: `dialog.scrollLeft` 0 → 1213 at 1024px and 0 → 1182 at 414px, and it never came back.

Each pill is now `position: relative`, so the input sits where it looks like it sits. The close chip on both sheets gains an explicit `z-index`, because sixteen positioned pills otherwise paint over a chip that was relying on tree order alone.

`@cire/ui/reveal` is new: a block that opens to its own height on a `grid-template-rows` transition and closes at once. The guest RSVP sheet and the landing demo use it for the "Anything else" field, so ticking "Other" no longer shoves the rest of the form down between two frames. A reply that already carries dietary prose opens with the field at full height and no animation.
