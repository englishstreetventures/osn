---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds the issue the agent would file for item 2 of a brief.

PASS if item 2's title states the outcome in the form `<Product> <surface>: <outcome>`, for example `Cire RSVP: …`.

FAIL if the title does not follow the form, or is an activity.

FAIL also if the file is missing or empty.
