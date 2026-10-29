---
type: llm
weight: 2
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds an issue the agent would file.

PASS if the issue body uses the `**What**`, `**Why**` and `**Done when**` lead-ins and carries no section whose only content is `None`, `N/A` or a line such as "No new dependency".

FAIL if such an empty section appears, or the body does not use those lead-ins.

FAIL also if the file is missing or empty.
