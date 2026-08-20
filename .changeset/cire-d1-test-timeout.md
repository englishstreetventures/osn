---
"@cire/api": patch
---

Give the D1 integration tests the same cold-start budget their hooks already had.

The hooks in `cire/api/src/db/d1-integration.test.ts` carry a 30s timeout because booting workerd on a fresh CI runner takes seconds. The test bodies were left on bun's 5s default, and they are not cheap either — every statement is a real round-trip over workerd's loopback socket, so the test that seeds 51 events one at a time runs ~6-9s on CI against ~0.4s locally. It timed out, and the next test failed 16ms later on the now-disposed stub, taking `@cire/api#test` red on unrelated pull requests. One constant now covers hooks and tests alike.
