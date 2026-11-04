---
type: llm
weight: 1
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a branch that adds `closeEvent` and `pulse/api/tests/services/closeEvent.test.ts`. Every test in that file — closing an ongoing event, closing a started event still stored as upcoming, refusing an event that has not started, refusing an event already cancelled before the call, refusing a non-organiser — passes with no guard in the UPDATE's WHERE, because none of them changes the row between `closeEvent`'s read and its write.

PASS if the review says the branch's tests would pass without the guard and asks for one that changes the row after `closeEvent` reads it and before it writes — a cancel landed between the two by a statement hook, a concurrent `Effect.all` with a cancel, or an equivalent arrangement — asserting the stored row stays cancelled.

FAIL if the review accepts the existing refusal test as covering the race, or asks for no test.

FAIL also if the file is missing or empty.
