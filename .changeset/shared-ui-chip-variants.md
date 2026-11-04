---
"@shared/ui": minor
---

`Chip` gains `variant="outline"` (a 1px border at 40% of the tone, no ground, at the filled chip's height), `treatment="tag"` (a label in sentence case at normal spacing, drawn as cire's hand-written tags were) and a `danger` tone. Filled `success`, `pending` and `accent` chips now tint at 8%, so their words clear 4.5:1 on a pale theme; the neutral chip renders the classes it did before. `Chip` spreads the rest of a span's safe props and takes a layout class, and drops a `title`.
