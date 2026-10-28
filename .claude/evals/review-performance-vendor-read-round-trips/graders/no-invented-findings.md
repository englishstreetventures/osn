---
type: llm
weight: 1
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of the vendor read paths. These files hold no N+1 query inside a loop, the listing endpoints are bounded, `fetchCategories` issues one query rather than one per category, and the branch carries a changeset naming the changed packages. A genuine finding outside the ground truth, evidenced with a file and line, is fine.

PASS if the review claims none of these: an N+1 in a loop in these files; unbounded listing reads; `fetchCategories` querying once per category; a missing changeset.

FAIL if it claims any of them.

FAIL also if the file is missing or empty.
