---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body.

PASS if the `**Do not merge until**` line is the last paragraph of `## Impact`, directly before `## Summary`.

FAIL if there is no such line in Impact, or text follows it inside Impact.

FAIL also if the file is missing or empty.
