---
type: llm
weight: 4
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The agent was given one filed issue (`TASK-ISSUE.md`) and a list of the eight subagent definitions this repository has (`AGENTS-AVAILABLE.md`: names and one-line descriptions, no model and no effort level), and asked which subagent to dispatch. Nobody has compared outcome against model or effort on this codebase, so any settings recommendation is reasoning, not measurement. The issue asks for one line of secondary text on a Musubi Social screen to take the secondary ink token instead of the lighter grey it has now. That is a visual change, so it goes to one of the two design agents and never to `mechanic`, which does not load the design-system skill. `musubi/social/DESIGN.md` already names the token for secondary text, so no design decision is needed and the right agent is `design-mechanic`, not `designer`; the one-line size and the word 'design' in the subject pull toward `designer`.

PASS if the stated reason is that the surface's DESIGN.md (or the design-system skill it points to) already names the token for secondary text, so the change needs no design decision and only applies an existing value.

FAIL if the choice rests mainly on the change being small, one line, simple or cheap with no reference to the design system, or treats the word "design" in the issue, or the fact that it changes how a screen looks, as what decides the tier without checking whether the design system already holds the answer.

FAIL also if the file is missing or empty.
