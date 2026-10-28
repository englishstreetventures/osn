---
type: llm
weight: 2
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The issue asks for a 'Pending verification' badge on a Musubi Social screen to be amber. `musubi/social/DESIGN.md` holds no amber or warning colour: its only chromatic colour is the destructive red, reserved for remove and delete. Adding a colour the system lacks is a design decision, so the right agent is `designer`, the tier that loads the design-system skill and makes that choice. `design-mechanic` only applies a value the design system already names; `mechanic` is not for visual changes and does not load the design system.

PASS if neither `design-mechanic` nor `mechanic` is the dispatch, and the reasoning says why.

FAIL if either is named as the dispatch, or the reasoning does not say why they are wrong here.

FAIL also if the file is missing or empty.
