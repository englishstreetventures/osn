---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds the issue the agent would file for item 2 of a brief.

PASS if item 2's body carries no section whose only content is `None`, `N/A` or a line such as "No new dependency".

FAIL if such an empty section appears, or there is no body for item 2.

FAIL also if the file is missing or empty.
