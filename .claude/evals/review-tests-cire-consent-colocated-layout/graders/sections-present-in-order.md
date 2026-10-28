---
type: llm
weight: 1
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review.

PASS if it has these 5 sections, each a `##` heading named exactly so, in this order: `## Build`, `## Tests`, `## Coverage gaps`, `## Files audited`, `## Not run`.

FAIL if any is missing, renamed, out of order or demoted below `##`.

FAIL also if the file is missing or empty.
