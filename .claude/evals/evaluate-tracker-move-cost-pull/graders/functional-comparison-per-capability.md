---
type: llm
weight: 3
focus: { source: file, path: EVALUATION.md }
---

The file evaluates moving issue tracking from GitHub Issues to Jira.

PASS if it compares the options capability by capability (a table or an equivalent list), covering at least all three of: planning or tracking depth, private-issue handling, and agent or `gh` tooling support, with a stated outcome for each option.

FAIL if any of those three capabilities is missing, or if the comparison is prose with no per-capability outcome for each option.
