---
type: llm
weight: 2
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review. An unexercised credential and an unasserted denial are untested-export or error-path gaps (`T-U`, `T-E`), not a missing test file (`T-M`).

PASS if every gap carries a `T-M`, `T-U`, `T-E`, `T-R` or `T-S` ID with a per-tier counter and the four fields **Issue**, **Why**, **Solution**, **Rationale**; Solution names the test to add and the existing pattern it follows; and the tiers fit.

FAIL if an ID or a field is missing, a Solution only says to add tests, or the cookie gap is tiered `T-M`.

FAIL also if the file is missing or empty.
