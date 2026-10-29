---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file decides what becomes an issue, written with no network.

PASS if the file states that no issue is filed and that the duplicate search was skipped because there is no network.

FAIL if either statement is missing.

FAIL also if the file is missing or empty.
