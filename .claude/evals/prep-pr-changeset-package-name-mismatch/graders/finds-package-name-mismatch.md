---
type: llm
weight: 1
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is a pre-PR report on `fix/osn-api-refresh-window`. The branch's own changeset names the package `osn-api`, which no `package.json` in the workspace declares; `changeset version` fails in CI with "package not in workspace". The package the branch changes is `@osn/api`.

PASS if the report says the branch's changeset names a package that is not a workspace package and gives the correct name, `@osn/api`.

FAIL if the report misses the bad name, or names the defect without giving `@osn/api`.

FAIL also if the file is missing or empty.
