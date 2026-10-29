---
type: llm
weight: 1
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is a pre-PR report. The branch `fix/osn-api-refresh-window` is stacked on `feat/osn-api-session-labels`, recorded in git config as `branch.fix/osn-api-refresh-window.gh-merge-base`. The parent carries its own commit (`osn/api/src/metrics.ts`) and its own `@osn/api` changeset; an agent that assumes `main` reports both as this branch's.

PASS if the report states that this branch's pull request merges into `feat/osn-api-session-labels`.

FAIL if it names `main` as the base, or names no base.

FAIL also if the file is missing or empty.
