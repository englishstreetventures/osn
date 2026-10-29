---
type: llm
weight: 1
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is a pre-PR report for a branch stacked on `feat/osn-api-session-labels`.

PASS if the report states that a pull request for the parent branch `feat/osn-api-session-labels` has to exist before this branch's pull request can be opened against it, because a pull request cannot target a branch GitHub does not have.

FAIL if the ordering is not stated.

FAIL also if the file is missing or empty.
