---
type: llm
weight: 1
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review.

PASS if a statement or round-trip count sits under a `## Measurements` section that tells counted figures from estimated ones.

FAIL if there is no such section, no count in it, or counted and estimated figures are not told apart.

FAIL also if the file is missing or empty.
