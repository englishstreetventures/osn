---
type: llm
weight: 2
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds the issue the agent would file for item 2 of a brief.

PASS if every line under item 2's **Done when** is something a reviewer could check and see fail: a command and its expected output, a behaviour at a named point, or a grep that returns nothing.

FAIL if any line could not be marked not done ("implemented", "works", "handled gracefully").

FAIL also if the file is missing or empty.
