---
type: llm
weight: 1
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a state-transition review of a branch whose diff is exactly these files:

- `.changeset/pulse-close-event.md`
- `pulse/api/src/services/events.ts`
- `pulse/api/tests/services/closeEvent.test.ts`

PASS if the file has no `##` heading beyond `## State findings`, `## For the tracker`, `## Writers`, `## Coverage` and `## Sections checked`; `## Coverage` gives a one-line verdict for each of the three files (a finding ID, `clear`, `no state written`, `not source`, or "not opened, because …"); and `## Sections checked` names the checks it applied with the file and line it looked at for each.

FAIL if an extra `##` section appears, a listed file has no Coverage line, a Sections-checked entry has no file beside it, or either section is missing.

FAIL also if the file is missing or empty.
