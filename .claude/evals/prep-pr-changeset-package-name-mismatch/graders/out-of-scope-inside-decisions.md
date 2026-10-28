---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body.

PASS if anything deliberately left unfixed sits under an **Out of scope** subsection or lead-in inside `## Decisions`, or the body leaves nothing out of scope and says so there.

FAIL if out-of-scope material is its own `##` section or is scattered across other sections.

FAIL also if the file is missing or empty.
