---
"@osn/auth-ui": minor
"@musubi/social": patch
---

`CheckEmailView`'s Resend shows how far its wait has gone: while it reads "Resend in {n}s", a fill behind the label, the ghost button's own hover fill led by a 2px edge in the faintest ink, at the disabled button's opacity, empties at an even pace over the whole wait and is gone as the label reads "Resend link". It is a CSS transition timed from the wait's own deadline, so a fill drawn after a send starts part-empty and still empties as Resend unlocks, and every wait after an accepted Resend runs the whole length again. It reads only `resendWaitSeconds`, the same for every address. It says nothing to a screen reader, holds no room in the button, and is not drawn under reduced motion, in a contrast theme or in a browser without `@starting-style`, where the label's seconds carry the wait alone. Musubi's `DESIGN.md` lists it among the app's motions, and its `CheckEmailView` layout browser test holds the fill's place, timing, colours in both themes, and absence under reduced motion and forced colours.
