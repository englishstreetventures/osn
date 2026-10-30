---
"@shared/ui": patch
---

`Modal` lays out nothing while closed, whatever classes it carries. A `frame` panel's `flex`, or a caller's own `flex`, beat the browser's rule that hides a closed `<dialog>`, so a modal kept mounted while closed drew as a bordered, shadowed strip at the top of whatever positioned it. A modal that was laid out while closed also opened with no entry transition; it now enters on its `opacity` and `transform` transitions.
