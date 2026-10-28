---
type: llm
weight: 2
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review. A redundant round trip on a request that is not yet hot is a `P-W` or `P-I`; nothing here is a production outage.

PASS if every finding carries a `P-C`, `P-W` or `P-I` ID with a per-tier counter and the four fields **Issue**, **Why**, **Solution**, **Rationale**; Why states the failure mode and the scale at which it bites; Solution is a concrete change; and no finding here is tiered `P-C`.

FAIL if an ID or a field is missing, Why or Solution is vague, or a finding is tiered `P-C`.

FAIL also if the file is missing or empty.
