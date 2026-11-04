---
type: llm
weight: 1
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a branch whose diff writes `events.status` in one new function. The other writers of that column are outside the diff: `applyTransition` and `applyTransitions`, `createEvent` and `updateEvent` in `pulse/api/src/services/events.ts`; `requestErasure` and `cancelErasure` in `pulse/api/src/services/accountErasure.ts`; `cancelSeries` and the series instance writes in `pulse/api/src/services/series.ts`.

PASS if the review lists, with a file for each, at least three writers of `events.status` that are outside the diff, together with the new `closeEvent`, and says for each what state it expects or whether it guards on one.

FAIL if it lists fewer than three writers outside the diff, or lists writers without saying where they are.

FAIL also if the file is missing or empty.
