---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds an issue the agent would file.

PASS if the issue body uses the bold lead-ins `**What**`, `**Why**` and `**Done when**`, in that order, each followed by real text.

FAIL if a lead-in is missing, out of order or empty, or the body uses another structure.

FAIL also if the file is missing or empty.
