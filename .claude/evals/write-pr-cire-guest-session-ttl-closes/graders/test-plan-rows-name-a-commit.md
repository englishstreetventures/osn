---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body.

PASS if every row of the `## Test plan` table names a short commit SHA for the branch head.

FAIL if any row lacks one, or there is no such table.

FAIL also if the file is missing or empty.
