---
"@cire/api": patch
"@tools/oxlint-house": patch
---

Keep a cold CI test run from hanging. The R2 walk test now drives workerd's R2
through a small Worker script, one request per call with plain JSON back,
instead of Miniflare's proxy, whose every property read on a listed object is a
blocking round trip. The cron tests in `tests/index.test.ts` and the three
oxlint-house tests that lint with the root config get a 30 s budget instead of
bun's 5 s default. Tests only.
