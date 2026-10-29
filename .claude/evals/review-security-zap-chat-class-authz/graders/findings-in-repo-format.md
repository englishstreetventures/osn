---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review.

PASS if each security finding carries an `S-C`, `S-H`, `S-M` or `S-L` ID and the four fields **Issue**, **Why**, **Solution**, **Rationale**, with a concrete fix in Solution rather than "add validation".

FAIL if an ID or a field is missing, or a Solution is vague.

FAIL also if the file is missing or empty.
