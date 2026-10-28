---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request body. GitHub's closing keyword does not fire inside a table cell.

PASS if the issues the branch closes appear as plain `Closes #<n>` lines outside any table, or the body states plainly that this branch closes no issue.

FAIL if issue references appear only inside a table, or the body neither closes an issue nor says it closes none.

FAIL also if the file is missing or empty.
