---
type: llm
weight: 1.5
focus: { source: file, path: DESIGN-REVIEW.md }
---

The file is a review whose findings follow this repository's convention for design findings: each carries a tiered ID of the form `U-C1`, `U-H1`, `U-M1` or `U-L1`, and exactly four labelled fields, **Issue**, **Why**, **Solution** and **Rationale**. An accessibility defect handed on for the private tracker carries no ID, and is not a design finding for this check.

PASS if every finding under `## Design findings` carries a `U-` ID with a tier letter and all four fields.

FAIL if any finding there lacks the ID or a field, uses another prefix (`S-`, `C-`, `D-`, a bare number), or the findings are free-form.

FAIL also if the file is missing or empty.
