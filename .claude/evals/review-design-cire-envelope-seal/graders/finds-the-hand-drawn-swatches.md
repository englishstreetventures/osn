---
type: llm
weight: 2
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review of a branch that adds `cire/host/src/components/invite/SealColourPicker.tsx`. Its four seal swatches are raw `<button role="radio">` elements with classes of their own and a chosen look of their own (a gold ring added through `classList`). `@cire/ui`'s `Button` already draws a one-of-several choice: its `choice` variant (with the `swatch` size for a frame round a colour), which the invite builder's own section-tone swatches use in `cire/host/src/components/invite/InviteBuilder.tsx`, with the colour passed as `style`.

PASS if the review carries a finding that the swatches are hand-drawn buttons and names `Button` from `@cire/ui` with its `choice` variant (naming the `swatch` size as well is fine) as what replaces them.

FAIL if the swatches are not reported, the finding names no shared component, or it names a component that does not exist in the repository.

FAIL also if the file is missing or empty.
