---
"@shared/ui": minor
---

`Modal` mounts its children only while it is open, and exports `heldWhileClosing`

Both came out of converting real overlays.

**The children are gated.** `Modal` stays mounted so it can animate its exit,
and that meant a modal which was merely *available* rendered its body into every
page offering it. In `cire/host` a live invite preview was rendering twice —
once in the sticky side pane, once inside a closed dialog — competing for the
same accessible name. Children mount when `open` goes true and unmount once the
exit has finished, so an expensive body costs nothing until it is asked for and
is still there to be animated away.

**`heldWhileClosing`** is for the other shape: a body that cannot render without
a value which closing sets to null. Confirming a plan closes the modal
correctly and unmounts the body on the same tick, so what fades away is an empty
bordered box. The helper keeps the last non-null value for exactly as long as
the exit needs it, and is a no-op for a modal whose contents stand on their own.
