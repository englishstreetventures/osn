---
type: llm
weight: 1
focus: { source: file, path: PREP-PR-REPORT.md }
---

The branch changes a line in `cire/api/src/routes/claim.ts` that `main` has since changed too, so the branch no longer merges into `main`.

PASS if the report says the branch conflicts with `main`, names `cire/api/src/routes/claim.ts` as the conflicting file, and says the branch is not ready to merge until the conflict is resolved.

FAIL if the report calls the branch ready, does not mention a conflict with `main`, or mentions one without naming the file.

FAIL also if the file is missing or empty.
