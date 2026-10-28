---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request title and body.

PASS if the body has all six second-level sections, `## Impact`, `## Summary`, `## Workspaces affected`, `## Issues`, `## Decisions` and `## Test plan`, and no seventh `##` heading.

FAIL if any is missing, the body is free-form or has a different set of sections, or an extra `##` appears.

FAIL also if the file is missing or empty.
