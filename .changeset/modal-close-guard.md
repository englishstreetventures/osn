---
"@shared/ui": patch
---

`Modal` guards `close()` the same way it already guarded `showModal()`

jsdom gives `<dialog>` an `open` property that reflects the attribute, so
`dialog.open` reads true there — while `close()` is missing entirely. The unmount
handler's bare `ref.close()` was therefore a `TypeError`, and because it threw
from a cleanup it took down the whole test file it was tidying up after rather
than just the modal: eighteen failures in a suite where two were real.

Both directions now go through a guarded helper — `showModal()` or the `open`
attribute on the way in, `close()` or removing it on the way out.
