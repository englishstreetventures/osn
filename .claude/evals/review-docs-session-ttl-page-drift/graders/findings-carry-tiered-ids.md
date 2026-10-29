---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review.

PASS if every finding carries a `D-C`, `D-H`, `D-M` or `D-L` ID with a per-tier counter.

FAIL if any finding lacks one, or there are no tiered IDs.

FAIL also if the file is missing or empty.
