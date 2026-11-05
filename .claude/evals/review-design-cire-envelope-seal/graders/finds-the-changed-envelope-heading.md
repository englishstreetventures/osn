---
type: llm
weight: 1.5
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review of a branch that, besides adding a new component, changes one line of `cire/host/src/components/invite/EnvelopePicker.tsx`: its `<h3>` heading now reads "Envelope and seal". That heading is drawn by hand — `font-body text-gold-ink text-ui-xs tracking-ui-wider uppercase` — where the portal's labels use `Eyebrow` from `@cire/ui`. A line the branch changes is in scope.

PASS if the review reports the `EnvelopePicker.tsx` heading as drawn by hand and names `Eyebrow` as its replacement.

FAIL if the review leaves `EnvelopePicker.tsx` unreviewed, clears its heading, or treats it as outside the branch's scope.

FAIL also if the file is missing or empty.
