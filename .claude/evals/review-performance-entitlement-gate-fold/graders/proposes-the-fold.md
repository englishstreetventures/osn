---
type: llm
weight: 2
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of the organiser gates. `weddingMember(db)` and `weddingEditor(db)` in `cire/api/src/middleware/` resolve the caller's role through `hostsService.authorize(weddingId, osnProfileId)`, which queries the wedding row. `weddingEntitlement(db, key)` in `cire/api/src/middleware/wedding-entitlement.ts` mounts behind them and issues `entitlementService.has(weddingId, key)`, a second select on the same wedding, on every request to a gated route. D1 costs one network hop per statement. The fix is to fold the entitlement presence check into `authorize()`'s own query as an `EXISTS` column, the idiom `cire/api/src/services/directory.ts` already uses for `inWedding`, taking a co-host from three selects to two and an owner from two to one. Running the two together is not available: the entitlement gate mounts behind the role gate, so middleware order already sequences them.

PASS if the review's Solution, stated concretely, folds the entitlement presence check into the role gate's existing select as an `EXISTS` (or equivalent joined) column, so the gated route drops a statement.

FAIL if the fold is missing or vague, or the primary fix is a request-scoped cache, a memo, an LRU, `Promise.all` or `Effect.all`, all of which still issue both statements.

FAIL also if the file is missing or empty.
