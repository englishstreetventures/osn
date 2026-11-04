---
type: llm
weight: 1.5
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review whose findings follow this repository's convention for state-transition findings: each carries a tiered ID of the form `G-C1`, `G-H1`, `G-M1` or `G-L1`, and exactly four labelled fields, **Issue**, **Why**, **Solution** and **Rationale**.

PASS if every finding under `## State findings` carries a `G-` ID with a tier letter and all four fields.

FAIL if any finding lacks the ID or a field, or uses another prefix (`S-`, `P-`, a bare number) for a state finding, or the findings are free-form.

FAIL also if the file is missing or empty.
