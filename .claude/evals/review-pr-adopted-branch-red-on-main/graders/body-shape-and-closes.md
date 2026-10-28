---
type: llm
weight: 1
focus: { source: file, path: REVIEW-PR-BODY.md }
---

The file is a replacement pull-request body. The skills pinned at this fixture predate the `## Impact` section, so it is optional.

PASS if the body has `## Summary`, `## Workspaces affected`, `## Issues`, `## Decisions` and `## Test plan` in that order, with no other second-level section except an optional `## Impact` before `## Summary`, and a `Closes #1630` line of its own, outside any table or code span.

FAIL if a section is missing, out of order or extra, or the closing line is missing or misplaced.

FAIL also if the file is missing or empty.
