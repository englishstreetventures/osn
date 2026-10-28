---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds the issue the agent would file for item 2 of a brief.

PASS if item 2's body uses the bold lead-ins `**What**`, `**Why**` and `**Done when**`, in that order, each followed by real text.

FAIL if a lead-in is missing, out of order or empty.

FAIL also if the file is missing or empty.
