---
type: llm
weight: 1
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review of a branch whose changed source files are exactly:

- `pulse/api/src/routes/account.ts`

PASS if the report has no `##` heading beyond `## Build`, `## Tests`, `## Coverage gaps`, `## Files audited` and `## Not run`, and `## Files audited` lists every file above, one line each, with the test file it pairs with and a verdict, naming any file it did not open as not opened.

FAIL if an extra `##` section appears, `## Files audited` is missing, or a listed file has no line there.

FAIL also if the file is missing or empty.
