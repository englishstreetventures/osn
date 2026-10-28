---
type: llm
weight: 2
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body. This check presumes the six sections `## Impact`, `## Summary`, `## Workspaces affected`, `## Issues`, `## Decisions`, `## Test plan` are all there.

PASS if the six sections appear in exactly that order and every section is present even when it has nothing to say, in which case it reads `None`; `## Impact` is never `None`, and an Impact that reads `None` counts as dropped.

FAIL if the sections are out of order, a section is silently dropped, or the six are not all there.

FAIL also if the file is missing or empty.
