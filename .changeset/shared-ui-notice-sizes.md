---
"@shared/ui": minor
---

`Notice` gains a `size` — `md`, the default box; `sm`, the same box compact; `inline`, no box at all, for the error line under a field — and an `accent` tone, a standing note in the accent's readable ink. `danger`, `warn` and `success` now lead with a circled icon (a cross, an exclamation mark, a tick) drawn inline in the tone's ink and sized from the text step, in place of a text glyph; the read words are unchanged. A new `mark` prop draws an app's own icon and read word in the same slot. With no `size` and no `tone`, a notice renders the classes it did before.
