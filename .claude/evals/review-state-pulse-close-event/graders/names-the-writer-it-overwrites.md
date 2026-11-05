---
type: llm
weight: 1
focus: { source: file, path: STATE-REVIEW.md }
---

The file is a review of a branch whose diff adds `closeEvent` to `pulse/api/src/services/events.ts`, writing `status: "finished"` with only the row id in its WHERE. The writes it can overwrite are all outside the diff: `requestErasure` in `pulse/api/src/services/accountErasure.ts` cancels a leaving host's events (status `cancelled` with `cancelledAt`, `hardDeleteAt` and `cancellationReason: "host_left"`); `updateEvent` in `pulse/api/src/services/events.ts` lets the organiser set any status, `cancelled` included; `cancelSeries` in `pulse/api/src/services/series.ts` cancels a series' future instances.

PASS if the review's finding on the unguarded close names at least one of those writers — by function or by file — as a write that can commit between `closeEvent`'s read and its write and be overwritten.

FAIL if the review names no competing writer, or names only writers inside the diff.

FAIL also if the file is missing or empty.
