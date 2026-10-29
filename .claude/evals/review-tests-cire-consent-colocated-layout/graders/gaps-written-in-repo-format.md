---
type: llm
weight: 2
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review. A missing test file is a `T-M` gap in this repository.

PASS if every gap carries a `T-M`, `T-U`, `T-E`, `T-R` or `T-S` ID with a per-tier counter and the four fields **Issue**, **Why**, **Solution**, **Rationale**; the missing test file is a `T-M`; and Solution names the test to add and the pattern the package's existing tests follow.

FAIL if an ID or a field is missing, the missing test file has another tier, or a Solution only says to add tests.

FAIL also if the file is missing or empty.
