---
type: llm
weight: 1
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review.

PASS if a statement count sits under a `## Measurements` section that separates what was counted from the diff from what was estimated.

FAIL if there is no such section, no count in it, or counted and estimated figures are not told apart.

FAIL also if the file is missing or empty.
