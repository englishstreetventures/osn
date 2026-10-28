---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review.

PASS if it has the three sections `## Scope`, `## Findings` and `## Suggested next sweeps`, named exactly so, in that order.

FAIL if any is missing, renamed, out of order or demoted below `##`.

FAIL also if the file is missing or empty.
