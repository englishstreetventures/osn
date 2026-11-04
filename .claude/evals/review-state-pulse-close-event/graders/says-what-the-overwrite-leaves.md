---
type: llm
weight: 1
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a branch that adds `closeEvent`, which writes `status: "finished"` and a new `endTime` with only the row id in its WHERE. If the account-erasure cancel (`requestErasure`, `pulse/api/src/services/accountErasure.ts`) lands between `closeEvent`'s read and its write, the row ends `finished` while `cancelledAt`, `cancellationReason: "host_left"` and `hardDeleteAt` stay set; `cancelErasure` in the same file later restores every `host_left` row to `upcoming` without checking its status, reopening an event the organiser closed. If an organiser's cancel through `updateEvent` lands instead, the cancel is lost and attendees see an event that ran rather than one that was called off.

PASS if the review states at least one concrete consequence of the overwrite: a finished row still carrying cancellation columns, `cancelErasure` or a restore reviving it, the hard-delete schedule left on a live or finished row, or a cancel silently lost so the event shows as having happened.

FAIL if the review says only that "state may be inconsistent" or "a race exists" without saying what the row or a later flow then does.

FAIL also if the file is missing or empty.
