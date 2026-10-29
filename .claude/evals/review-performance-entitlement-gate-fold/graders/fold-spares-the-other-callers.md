---
type: llm
weight: 3
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of the organiser gates. `weddingMember(db)` and `weddingEditor(db)` in `cire/api/src/middleware/` resolve the caller's role through `hostsService.authorize(weddingId, osnProfileId)`, which queries the wedding row. `weddingEntitlement(db, key)` in `cire/api/src/middleware/wedding-entitlement.ts` mounts behind them and issues `entitlementService.has(weddingId, key)`, a second select on the same wedding, on every request to a gated route. D1 costs one network hop per statement. The fix is to fold the entitlement presence check into `authorize()`'s own query as an `EXISTS` column, the idiom `cire/api/src/services/directory.ts` already uses for `inWedding`, taking a co-host from three selects to two and an owner from two to one. Running the two together is not available: the entitlement gate mounts behind the role gate, so middleware order already sequences them. The role gates are shared middleware and most routes that mount one mount no entitlement gate, so the entitlement key must be an optional parameter: only the three gated route files (`vendor-directory.ts`, `vendors.ts`, `registry.ts`) pay for the extra column, and every other caller runs exactly the query it ran before.

PASS if the review proposes the fold and says it must not make the many role-gate-only routes pay for a column they never read, with the mechanism: the entitlement key is an optional parameter, and a caller passing none runs the query it ran before.

FAIL if no fold is proposed, the other callers are not mentioned, or the concern is raised without that mechanism.

FAIL also if the file is missing or empty.
