---
type: llm
weight: 1
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of the organiser gates. `weddingMember(db)` and `weddingEditor(db)` in `cire/api/src/middleware/` resolve the caller's role through `hostsService.authorize(weddingId, osnProfileId)`, which queries the wedding row. `weddingEntitlement(db, key)` in `cire/api/src/middleware/wedding-entitlement.ts` mounts behind them and issues `entitlementService.has(weddingId, key)`, a second select on the same wedding, on every request to a gated route. D1 costs one network hop per statement.

PASS if the review counts statements rather than asserting slowness: a gated organiser request costs the role gate's query plus the entitlement gate's, and the fold removes one per request on every gated route.

FAIL if there is no count.

FAIL also if the file is missing or empty.
