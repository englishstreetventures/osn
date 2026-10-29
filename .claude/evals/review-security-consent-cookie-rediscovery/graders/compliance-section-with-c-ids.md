---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review.

PASS if it has a compliance section, placed after the security findings, whose findings use `C-` IDs.

FAIL if there is no compliance section, it comes before the security findings, or its findings carry no `C-` IDs.

FAIL also if the file is missing or empty.
