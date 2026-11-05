---
type: llm
weight: 2
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review of a branch that adds `cire/host/src/components/invite/SealColourPicker.tsx`. Its heading, "Seal colour", is an `<h3>` drawn by hand from on-token classes — `font-body text-gold-ink text-ui-xs tracking-ui-wider uppercase`. The host portal draws every such label with `Eyebrow` from `@cire/ui` (`cire/ui/src/eyebrow.tsx`), imported as `import Eyebrow from "@cire/ui/eyebrow"` across `cire/host/src`.

PASS if the review carries a finding that the "Seal colour" heading is drawn by hand and names `Eyebrow` (or `@cire/ui/eyebrow`) as what replaces it.

FAIL if the heading is not reported, is reported without naming `Eyebrow`, or is cleared as acceptable.

FAIL also if the file is missing or empty.
