---
type: llm
weight: 0.5
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The issue asks for one line of secondary text on a Musubi Social screen to take the secondary ink token instead of the lighter grey it has now. That is a visual change, so it goes to one of the two design agents and never to `mechanic`, which does not load the design-system skill. `musubi/social/DESIGN.md` already names the token for secondary text, so no design decision is needed and the right agent is `design-mechanic`, not `designer`; the one-line size and the word 'design' in the subject pull toward `designer`.

PASS if the file does not do the task it is choosing an agent for: no edited class name, no diff, no proposed patch to the screen. Naming the token in one clause as the reason is fine.

FAIL if the file writes the change, or carries a diff or patch.

FAIL also if the file is missing or empty.
