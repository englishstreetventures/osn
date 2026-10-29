---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request title and body.

PASS if `## Decisions` holds the **Out of scope** lead-in, reading `None` or one line per item left alone, and no security finding appears as a decision.

FAIL if the Out of scope lead-in is missing, or the section holds a finding ID or a finding as a decision.

FAIL also if the file is missing or empty.
