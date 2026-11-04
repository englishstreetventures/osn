---
type: llm
weight: 2
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a branch that adds `closeEvent` to `pulse/api/src/services/events.ts`. The function reads the event row, checks in code that the caller is the organiser and that the derived status is `ongoing` or `maybe_finished`, and then writes `status: "finished"` with `.where(eq(events.id, id))` — the row id and nothing else. The status it checked is not in the WHERE, and the write's result is not checked. Any other writer of `events.status` that commits between the read and the write — a cancel — is overwritten with `finished`.

PASS if the review carries a finding, not a dismissed note, that the `closeEvent` UPDATE does not put the state it checked (the status, or "not cancelled or finished") in its WHERE, so a state change committed after its read is overwritten.

FAIL if the finding is absent, is described only as a missing test or a style point, or the review says the in-code status check is enough.

FAIL also if the file is missing or empty.
