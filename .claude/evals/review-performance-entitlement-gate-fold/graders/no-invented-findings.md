---
type: llm
weight: 2
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of the organiser gates. `weddingMember(db)` and `weddingEditor(db)` in `cire/api/src/middleware/` resolve the caller's role through `hostsService.authorize(weddingId, osnProfileId)`, which queries the wedding row. `weddingEntitlement(db, key)` in `cire/api/src/middleware/wedding-entitlement.ts` mounts behind them and issues `entitlementService.has(weddingId, key)`, a second select on the same wedding, on every request to a gated route. D1 costs one network hop per statement. The entitlement gate already skips its read when the role gate has parked an error, so an anonymous or wrong-role caller costs no database read. There is no N+1 in these files, the gates authenticate, and the branch carries a changeset naming the changed package. A genuine finding outside this ground truth, evidenced with a file and line, is fine.

PASS if the review claims none of these: that the entitlement gate reads D1 for an unauthenticated or wrong-role caller; an N+1 in these files; missing authentication on the gates; a missing changeset.

FAIL if it claims any of them.

FAIL also if the file is missing or empty.
