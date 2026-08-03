---
"@osn/api": patch
---

Fix graph/organisation routes swallowing every business-rule error into a
generic "Request failed".

Route handlers run service effects through `ManagedRuntime.runPromise` (see
`makeAppRunner`), which rejects with Effect's `FiberFailure` wrapping the
typed failure — never the tagged error itself. The per-route `safeError`
copies checked `_tag` on the caught value directly, so the check never
matched: tagged `GraphError` / `OrgError` / `NotFoundError` messages
("Connection already exists", "Cannot connect to yourself", "Pending request
not found", …) all collapsed into the generic "Request failed". In
`@osn/social` this surfaced as an unexplained "Request failed" toast when
Connect hit an already-pending edge (e.g. the other person had already sent
a request, or a previous click had succeeded despite the error toast).

The four copies are replaced by a shared `makeSafeError(allowedTags)` in
`osn/api/src/lib/safe-error.ts` that unwraps a `FiberFailure` to its typed
failure (`Runtime.isFiberFailure` → `Cause.failureOption`) before applying
the tag allowlist. Non-allow-listed failures (`DatabaseError`, defects) still
collapse to the generic message, so the S-M17 no-leak invariant is unchanged.
