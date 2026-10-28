---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review.

PASS if every finding is written in the four fields **Issue**, **Why**, **Solution**, **Rationale**, with the Issue quoting the offending line and its `file:line`.

FAIL if any finding is free-form, lacks a field, or its Issue lacks the quoted line or its location.

FAIL also if the file is missing or empty.
