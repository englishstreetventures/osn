---
"@shared/ui": minor
---

`Modal` animates, and its exit works in every engine rather than only in Chrome

Entry is `@starting-style` — pure CSS, no JavaScript, from-state taken by the
browser when the element first renders.

Exit could not be, and the reason is worth stating because the CSS-only answer
looks like it should work. `close()` removes a dialog from the top layer
*immediately*, so an exit transition has nothing left to paint. The platform's
fix is the `overlay` property with `transition-behavior: allow-discrete`, which
defers that removal — and `overlay` is **Chrome and Edge only**, unsupported in
Safari and Firefox. On the surface this component was built for, cire's guest
site, most traffic is mobile Safari, so a CSS-only exit would mean the dialog
blinking away for nearly everyone who sees it.

So `Modal` defers the `close()` call instead: it sets `data-closing`, lets its
stylesheet run the exit, and closes once the element's animations have finished.
It waits on `getAnimations({ subtree: true })` rather than a named transition,
so an app animating the panel with Motion One or the Web Animations API is
waited out the same way — the hook is animation-library-agnostic without naming
a library. A reopen mid-exit is tracked by a token, so a stale close cannot land
on a dialog somebody has just reopened.

Timing is `--ui-modal-enter` and `--ui-modal-exit`, so an app retimes rather
than restyles. `prefers-reduced-motion` drops both to 1ms rather than `none`:
the exit is awaited, and a transition that never started is one there is nothing
to wait for.

**Callers must keep the modal mounted across the close** — `Modal` can only
animate an element that is still in the document. `<Show when={x}>{() => <Modal
open …>}</Show>` unmounts it the instant `x` goes null and the exit silently does
not play. The docblock and `wiki/architecture/component-library.md` both say so,
and the fix is to put the `Show` inside the modal.

Eight new browser tests cover it, including that the dialog stays in the top
layer while the exit runs, that something is genuinely animating rather than the
attribute merely being set, that a reopen beats a stale close, and that an
unmount mid-exit leaves nothing inert.
