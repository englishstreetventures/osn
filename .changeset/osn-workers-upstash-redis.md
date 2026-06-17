---
"@shared/redis": minor
"@osn/api": minor
"@pulse/api": patch
---

Add a Workers-compatible Upstash REST Redis backend (migration Phase 2).

`@shared/redis` now ships three interchangeable `RedisClient` backends behind
the same interface, split so the Workers bundle never statically imports
`ioredis` (which needs Node `net`/`tls` sockets and cannot run on workerd):

- **ioredis split to a subpath.** `wrapIoRedis`, `createClientFromUrl`,
  `ConnectableRedisClient`, and the Effect `RedisLive` layer moved to a new
  `@shared/redis/ioredis` subpath export. The top-level `@shared/redis` entry
  now exports only the `RedisClient` interface, the in-memory client, and the
  new Upstash client — no static `ioredis` import in its graph.
- **Upstash adapter.** New `@shared/redis/upstash` with `wrapUpstash(redis)`
  and `createUpstashClient({ url, token })`. `createUpstashClient` sets
  `automaticDeserialization: false` so `get` returns raw strings (matching
  ioredis and the rotated-session-store's opaque family-id round-trips); `set`
  maps `pxMs` to `{ px }`; `eval` passes the script/keys/args straight through
  (preserving numeric returns for the rate-limit Lua and the `1`/`"1"` step-up
  jti check); `quit` is a no-op for the stateless REST transport.

`@osn/api` gains `initRedisClientFromEnv(env)` — a synchronous, ioredis-free,
side-effect-free selector that returns `createUpstashClient(...)` when both
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are present on the
Workers `env` binding, else an in-memory client. It performs no startup health
check, has no `REDIS_REQUIRED` fail-closed mode, and never calls
`process.exit` — those stay on the Bun `initRedisClient` path, which is
unchanged. Consumers (rate limiters, rotated-session/step-up/ceremony stores)
remain backend-agnostic; no call sites changed.
