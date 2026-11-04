---
type: llm
weight: 1
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a branch that adds `closeEvent` to `pulse/api/src/services/events.ts`; its UPDATE carries only `eq(events.id, id)` and ignores the write's result. The fix puts the prior state in the WHERE — the stored status read (`eq(events.status, existing.status)`), or a "not cancelled and not finished" predicate — and checks what the write matched (`.returning()` or the changed-row count), refusing or re-reading when it matched nothing instead of returning a finished event.

PASS if the review's finding proposes both parts: the state in the UPDATE's WHERE, and a check of the rows the write changed with a refusal or re-read on zero.

FAIL if it proposes only one of the two, proposes only a transaction or a lock (D1 has no interactive transactions), or proposes no remedy.

FAIL also if the file is missing or empty.
