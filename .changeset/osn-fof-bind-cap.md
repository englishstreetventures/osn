---
"@osn/api": patch
---

P-C1 (osn-tracker#589) — `GET /recommendations/connections` threw for any
caller with more than 50 accepted connections. The friends-of-friends fan-out
bound the caller's connection ids twice, once per edge direction, and D1 caps
a query at 100 bound parameters — 51 accepted connections already produced
102 binds and threw `D1_ERROR: too many SQL variables` in production.

Fixed by binding `profileId` instead of the id list: the fan-out now reads
the caller's own accepted edges through a correlated `IN (<subquery>)`
rather than pasting them in as literals, so the bind count is fixed
regardless of how many connections the caller has. Measured on real
(Miniflare/workerd) D1: a correlated `EXISTS` was tried first and rejected
(it planned as a full scan of the whole `connections` table); the
`IN (<subquery>)` shape uses the same indexes the original query did and
reads 484 rows against the old shape's 400 for an identical 40-connection
result set.

`osn/api/src/d1-integration.test.ts` had a characterisation test pinning the
broken behaviour (added on the parent branch); it now asserts the call
succeeds with a connection count well past the old cliff and returns the
correct friend-of-friend candidates.

Security review of that fix found a regression it introduced (S-H1): the
fan-out's new seed subquery reads `connections` live, in its own D1 round
trip, separate from the earlier snapshot `suggestConnections` takes of the
caller's own edges — a window the old, single-snapshot query could not open.
A connection the caller accepted from a second in-flight request, in that
window, was misclassified as a suggestion candidate rather than a mutual
connection, so the caller's own brand-new connection could come back as
"someone you may know." Fixed by re-checking, fresh, against `connections`
and `blocks` immediately before hydration, for just the ids that survived
ranking (at most 50) — bound once per query via the same `IN (<subquery>)`
shape, 53 params measured against real D1, not the 102 a naive two-sided
`inArray` would cost at that size.
