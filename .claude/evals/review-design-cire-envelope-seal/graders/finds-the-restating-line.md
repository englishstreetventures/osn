---
type: llm
weight: 1.5
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review of a branch that adds `cire/host/src/components/invite/SealColourPicker.tsx`. Directly under its "Seal colour" heading sits a paragraph, "Choose a colour for the seal.", that says nothing the heading and the swatches do not already say. `cire/host/DESIGN.md` §3 rules that a line earns its place: a line that only repeats what the screen already says is not drawn.

PASS if the review reports the "Choose a colour for the seal." line as restating the heading or the screen, and proposes removing it.

FAIL if the line is not reported, or is reported only as a wording or tone suggestion that keeps it.

FAIL also if the file is missing or empty.
