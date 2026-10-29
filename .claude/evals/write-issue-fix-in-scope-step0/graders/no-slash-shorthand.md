---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds the issue the agent would file for item 2 of a brief.

PASS if neither item 2's title nor its body uses slash shorthand between two words (`owner/editor`, `paid/refunded`). File paths and repository names are not shorthand.

FAIL if any slash shorthand appears.

FAIL also if the file is missing or empty.
