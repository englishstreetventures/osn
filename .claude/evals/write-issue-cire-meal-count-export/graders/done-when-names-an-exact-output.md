---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds an issue the agent would file.

PASS if at least one line under **Done when** names an exact CSV header or count.

FAIL if none does.

FAIL also if the file is missing or empty.
