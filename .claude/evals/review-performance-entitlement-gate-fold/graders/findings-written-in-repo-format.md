---
type: llm
weight: 2
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review. A redundant round trip on a gate is a `P-W`, not a production outage.

PASS if every finding carries a `P-C`, `P-W` or `P-I` ID with a per-tier counter and the four fields **Issue**, **Why**, **Solution**, **Rationale**; Rationale says why the change removes the cost without adding one elsewhere; and each tier is defensible.

FAIL if an ID or a field is missing, Rationale does not address cost moved elsewhere, or the redundant gate lookup is tiered `P-C`.

FAIL also if the file is missing or empty.
