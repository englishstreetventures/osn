---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review.

PASS if it has no `##` heading beyond `## Scope`, `## Findings` and `## Suggested next sweeps`; `## Scope` names the files reviewed and the cross-checks run against the source; and `## Suggested next sweeps` holds at most three items.

FAIL if an extra `##` heading appears, Scope omits the files or the cross-checks, or there are more than three sweeps.

FAIL also if the file is missing or empty.
