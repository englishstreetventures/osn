---
type: llm
weight: 2
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review of the `/account` routes. `pulse/api/src/routes/account.ts` authenticates its three handlers (account deletion, restore, deletion status) through `resolveCaller`, built by `makeCallerResolver` in `pulse/api/src/lib/caller.ts`, which accepts either an `Authorization` bearer access token or the `pulse_web_session` cookie. Every case in `pulse/api/tests/routes/account.test.ts` presents a bearer token, so the cookie path is never exercised. These are the data-subject-request handlers, and the browser client cannot present a bearer token at all.

PASS if the report says the tests exercise only one of the two credentials `resolveCaller` accepts (every case sends a bearer token, none sends the `pulse_web_session` cookie), naming `pulse/api/tests/routes/account.test.ts` and the resolver or its two credentials.

FAIL if the gap is missing, or the test file or the resolver and its credentials are not named.

FAIL also if the file is missing or empty.
