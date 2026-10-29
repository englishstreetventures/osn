---
type: llm
weight: 2
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds an issue the agent would file.

PASS if every line under **Done when** is something a reviewer could check and see fail: a command and its expected output, a behaviour on a named screen, a CSV header or row to compare, or a grep that returns nothing.

FAIL if any line could not be marked not done ("implemented", "works", "handled gracefully").

FAIL also if the file is missing or empty.
