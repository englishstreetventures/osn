---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review.

PASS if every finding carries a tiered ID in the `S-C`, `S-H`, `S-M`, `S-L`, `P-` or `C-` style and exactly four labelled fields: **Issue**, **Why**, **Solution**, **Rationale**.

FAIL if any finding lacks the ID or one of the four fields, or the findings are free-form.

FAIL also if the file is missing or empty.
