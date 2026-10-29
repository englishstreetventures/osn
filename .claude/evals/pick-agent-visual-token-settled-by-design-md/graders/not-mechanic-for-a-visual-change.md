---
type: llm
weight: 2
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The issue asks for one line of secondary text on a Musubi Social screen to take the secondary ink token instead of the lighter grey it has now. That is a visual change, so it goes to one of the two design agents and never to `mechanic`, which does not load the design-system skill. `musubi/social/DESIGN.md` already names the token for secondary text, so no design decision is needed and the right agent is `design-mechanic`, not `designer`; the one-line size and the word 'design' in the subject pull toward `designer`.

PASS if the reasoning says a visual change goes to one of the two design agents whatever its size, and `mechanic` is named nowhere as the dispatch or the fallback.

FAIL if `mechanic` is named as the dispatch or the fallback, the answer argues a visual change can go to a non-design agent because it is mechanical, or the reasoning never says why `mechanic` is out.

FAIL also if the file is missing or empty.
