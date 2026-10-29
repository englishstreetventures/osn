---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file's first line is `Title: <the title>`.

PASS if the title is at most 70 characters, leads with the product or area (for example `Cire API: …`), says in plain words what changes for the person using it, and carries no conventional-commit prefix (`fix(api):`).

FAIL if it is longer, has a conventional-commit prefix, or does not lead with the product or area.

FAIL also if the file is missing or empty.
