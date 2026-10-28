---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds an issue the agent would file.

PASS if the title states the outcome for the person using it in the form `<Product> <surface>: <outcome>` (for example `Cire organiser export: …`).

FAIL if the title is an activity ("Improve export", "Look into guest CSV"), an issue number, a conventional-commit prefix or an internal draft ID, or does not follow the form.

FAIL also if the file is missing or empty.
