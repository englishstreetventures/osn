---
type: llm
weight: 2
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request title and body.

PASS if the six sections `## Impact`, `## Summary`, `## Workspaces affected`, `## Issues`, `## Decisions`, `## Test plan` appear in that order, and a section with nothing to say keeps the word `None` rather than being dropped.

FAIL if they are out of order, a section is empty without `None`, or the six are not all there.

FAIL also if the file is missing or empty.
