---
"@shared/ui": patch
---

`Modal` degrades instead of throwing where `<dialog>` is unimplemented

jsdom implements no part of `<dialog>` — `showModal` is `undefined` there, not
merely inert — so calling it unguarded is a `TypeError` that takes the whole
render down. `Modal` now falls back to the `open` attribute: a non-modal dialog,
visible and with its contents reachable, without the top layer, focus trap or
Escape that the method is what provides.

That is a test environment rather than a browser, but the same is true of any
server render, and a component that throws where it cannot do its best work is
worse than one that degrades.
