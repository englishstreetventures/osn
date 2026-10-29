---
type: llm
weight: 4
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The agent was given one filed issue (`TASK-ISSUE.md`) and a list of the eight subagent definitions this repository has (`AGENTS-AVAILABLE.md`: names and one-line descriptions, no model and no effort level), and asked which subagent to dispatch. Nobody has compared outcome against model or effort on this codebase, so any settings recommendation is reasoning, not measurement. The issue asks for a 'Pending verification' badge on a Musubi Social screen to be amber. `musubi/social/DESIGN.md` holds no amber or warning colour: its only chromatic colour is the destructive red, reserved for remove and delete. Adding a colour the system lacks is a design decision, so the right agent is `designer`, the tier that loads the design-system skill and makes that choice. `design-mechanic` only applies a value the design system already names; `mechanic` is not for visual changes and does not load the design system.

PASS if the stated reason is that the surface's DESIGN.md (or the design-system skill it points to) holds no amber or warning colour, so the change adds a value the design system lacks and is a design decision.

FAIL if the choice rests mainly on the change being small, one line, simple or cheap with no reference to the design system, or treats the change as mechanical because it is one class on one element without checking whether the design system holds the colour.

FAIL also if the file is missing or empty.
