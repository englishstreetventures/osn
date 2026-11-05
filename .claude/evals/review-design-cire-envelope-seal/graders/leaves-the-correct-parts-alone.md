---
type: llm
weight: 2
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review of a branch that adds `cire/host/src/components/invite/SealColourPicker.tsx`. Two things in it are correct:

- The hex values in `SEALS` (`#8b1a1a`, `#1f4d2b`, `#1b2340`, `#b08d3c`) are the colours of the wax a guest's seal is pressed in: content the organiser chooses, shown by each swatch through `style`, as the invite builder's section-tone swatches show theirs. They are data, not chrome, and no design token stands for them.
- The locked note is `Notice` from `@shared/ui` at its `accent` tone and `sm` size, which is how the portal draws a standing note.

PASS if the review reports neither as a defect. Listing either as checked and clear is fine.

FAIL if the review asks for the seal hex values to become design tokens, or reports the `Notice` as wrong.

FAIL also if the file is missing or empty.
