---
type: llm
weight: 1.5
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review of a branch that adds `cire/host/src/components/invite/SealColourPicker.tsx`. Its swatch buttons take focus and carry `transition-colors`, which also fades `outline-color`, so the focus ring arrives over the hover's duration. `cire/host/DESIGN.md` §4 rules that a focus ring never animates and that a colour hover on anything that takes focus uses `transition-ui-colors`.

PASS if the review reports `transition-colors` on the swatches and names `transition-ui-colors` (or naming the transition's properties explicitly so the outline is left out) as the fix — whether as a finding of its own or inside the swatch finding, as long as it is stated.

FAIL if `transition-colors` is not mentioned as a defect.

FAIL also if the file is missing or empty.
