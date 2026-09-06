---
"@shared/redis": patch
"@osn/api": patch
"@pulse/api": patch
---

Take ioredis 6.0.0 (from 5.11.1). This is not a dev-only bump: `osn/api/src/index.ts` and `pulse/api/src/index.ts` both statically import `./redis`, which statically imports `@shared/redis/ioredis`, so ioredis is compiled into both deployed Worker bundles and its module body runs at isolate startup. v6 drops the `redis-parser` package for an in-tree RESP decoder — confirmed, `redis-parser` is gone from the lockfile.

Verified by booting the real built bundle on workerd (`wrangler dev --local`), not by a dry run: `osn-api` starts clean and serves 200 on `/health`, `/.well-known/jwks.json` and `/`, with no errors in the log. The Worker bundle grows 4594.90 KiB to 4716.41 KiB.

One thing the bundle growth understates, found while reviewing this bump and filed separately: the ioredis in these Worker bundles can never execute. `osn/api/src/index.ts` reaches it only through `initRedisClientFromEnv`, which on workerd selects Upstash-over-HTTP or the in-memory store; the socket-opening `createClientFromUrl` is reached solely from `osn/api/src/local.ts`. Stubbing that one import out and rebuilding puts ioredis at 449.58 KiB raw / 72.50 KiB gzip in `osn-api`, about 8.8% of the compressed script, parsed on every cold isolate start. That is pre-existing — it was 337.98 / 61.75 KiB gzip on ioredis 5 — and this bump adds 111.60 / 10.75 to it. The fix is a module split in `@shared/redis`, not a change to this bump.
