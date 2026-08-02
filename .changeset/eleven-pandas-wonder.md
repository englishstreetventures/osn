---
"@cire/api": patch
---

Add the missing `test:d1` script so the D1 integration lane runs in CI

`@cire/api` was the only API package without a `test:d1` script, so its
`src/db/d1-integration.test.ts` had no entry point at all. It now matches osn,
pulse and zap, and all four are invoked by a new root `bun run test:d1` from
both `ci.yml` and `deploy.yml`.

That lane is the only coverage of the asynchronous D1 driver used by
dev/staging/prod — every other suite runs on synchronous `bun:sqlite` — and it
had never run in CI, which let zap's test rot into a stale fixture that was
failing silently. It is pinned to `--concurrency=1`: concurrent Miniflare
workerd instances contend and fail spuriously.
