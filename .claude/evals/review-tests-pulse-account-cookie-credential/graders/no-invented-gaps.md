---
type: llm
weight: 2
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review of the `/account` routes. `pulse/api/src/routes/account.ts` authenticates its three handlers (account deletion, restore, deletion status) through `resolveCaller`, built by `makeCallerResolver` in `pulse/api/src/lib/caller.ts`, which accepts either an `Authorization` bearer access token or the `pulse_web_session` cookie. Every case in `pulse/api/tests/routes/account.test.ts` presents a bearer token, so the cookie path is never exercised. These are the data-subject-request handlers, and the browser client cannot present a bearer token at all. `pulse/api/tests/routes/account.test.ts` exists and drives real requests through `createAccountRoutes`; the 401 and 403 gates are asserted, including an expired bearer token; the package keeps its tests in a mirrored `tests/` tree. A genuine gap outside this ground truth, evidenced with a file and an export, is fine.

PASS if the report claims none of these: that the routes have no test file or no route-level HTTP tests; that the 401 or 403 gates are unasserted; that the package lacks a `tests/` directory or mirrored layout.

FAIL if it claims any of them.

FAIL also if the file is missing or empty.
