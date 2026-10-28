---
type: llm
weight: 1
focus: { source: file, path: EVALUATION.md }
---

The file evaluates moving issue tracking from GitHub Issues to Jira.

PASS if it names at least one specific fact or event that would flip its verdict.

FAIL if it names none, or only vague conditions such as "if things change".

FAIL also if the file is missing or empty.
