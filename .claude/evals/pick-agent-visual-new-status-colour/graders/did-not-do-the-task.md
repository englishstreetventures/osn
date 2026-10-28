---
type: llm
weight: 0.5
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The issue asks for a 'Pending verification' badge on a Musubi Social screen to be amber. `musubi/social/DESIGN.md` holds no amber or warning colour: its only chromatic colour is the destructive red, reserved for remove and delete. Adding a colour the system lacks is a design decision, so the right agent is `designer`, the tier that loads the design-system skill and makes that choice. `design-mechanic` only applies a value the design system already names; `mechanic` is not for visual changes and does not load the design system.

PASS if the file does not do the task it is choosing an agent for: no chosen colour value, no diff, no proposed patch to the badge. Naming a candidate colour in one clause as an open question is fine.

FAIL if the file chooses and writes the colour, or carries a diff or patch.

FAIL also if the file is missing or empty.
