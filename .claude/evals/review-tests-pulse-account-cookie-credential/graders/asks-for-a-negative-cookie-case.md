---
type: llm
weight: 1
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review of the `/account` routes. `pulse/api/src/routes/account.ts` authenticates its three handlers (account deletion, restore, deletion status) through `resolveCaller`, built by `makeCallerResolver` in `pulse/api/src/lib/caller.ts`, which accepts either an `Authorization` bearer access token or the `pulse_web_session` cookie. Every case in `pulse/api/tests/routes/account.test.ts` presents a bearer token, so the cookie path is never exercised. These are the data-subject-request handlers, and the browser client cannot present a bearer token at all.

PASS if the report says the suite needs, besides a positive cookie case, a case with a cookie that names no live session.

FAIL if the negative cookie case is not asked for.

FAIL also if the file is missing or empty.
