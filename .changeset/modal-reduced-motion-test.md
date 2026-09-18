---
"@shared/ui": patch
---

`Modal`'s reduced-motion behaviour gets a browser test, and a `prefers-reduced-motion` command to write it with

The 1ms clamp is load-bearing rather than cosmetic: the exit is *awaited*, so a
transition that was never started is one there is nothing to wait for. `none`
would leave `getAnimations()` empty — which happens to work, but takes the close
down a different path from the one every other engine uses.

The only assertion that existed for it went with the hand-rolled overlay the
component replaced, and nothing put it back. Two cases now cover the duration
and, more usefully, that the awaited exit still resolves — a modal that never
finished closing under reduced motion would be a dialog nobody could dismiss.
