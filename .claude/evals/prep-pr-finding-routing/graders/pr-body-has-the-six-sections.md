---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body.

PASS if it has all six second-level sections, `## Impact`, `## Summary`, `## Workspaces affected`, `## Issues`, `## Decisions`, `## Test plan`, and no other `##` heading.

FAIL if any of the six is missing or renamed, the body is free-form, or an extra `##` section appears.

FAIL also if the file is missing or empty.
