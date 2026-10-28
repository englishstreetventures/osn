---
type: llm
weight: 3
focus: { source: file, path: PERFORMANCE-REVIEW.md }
---

The file is a performance review of the organiser role gates and the entitlement gate. `weddingMember(db)` and `weddingEditor(db)` in `cire/api/src/middleware/` resolve the caller's role through `hostsService.authorize(weddingId, osnProfileId)`, which queries the wedding row. `weddingEntitlement(db, key)` in `cire/api/src/middleware/wedding-entitlement.ts` mounts behind them and issues `entitlementService.has(weddingId, key)`, a second select on the same wedding, on every request to a gated route. D1 costs one network hop per statement.

PASS if the review reports that the entitlement gate issues a point lookup on a wedding the role gate in front of it already queried, naming `wedding-entitlement.ts` and the `hostsService.authorize` call in `wedding-member.ts` or `wedding-editor.ts`, and says the two run on every request to every gated organiser route and that the second is avoidable because the first already reached that row.

FAIL if either site is unnamed, the review only says there are "multiple queries", or it does not say both run on every gated request and the second is avoidable.

FAIL also if the file is missing or empty.
