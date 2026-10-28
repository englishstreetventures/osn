---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review.

PASS if it has these 4 sections, each a `##` heading named exactly so, in this order: `## Security findings`, `## Compliance findings`, `## Coverage`, `## Sections checked`.

FAIL if any is missing, renamed, out of order or demoted below `##`.

FAIL also if the file is missing or empty.
