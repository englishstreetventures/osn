---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body for a branch cut for issue #9131.

PASS if `## Issues` closes the issue with `Closes #9131` on a line of its own, outside any table or code span.

FAIL if the closing line is missing, malformed, inside a table or code span, or reads `Part of #9131`.

FAIL also if the file is missing or empty.
