---
"@shared/db-utils": patch
"@shared/redis": patch
---

Pin the search string-math with property tests, and let Effect own the Redis
startup deadline.

`search.ts` states its invariants in doc comments as facts — `handlePrefixRange`
claims to be *exactly equivalent* to `handle LIKE 'q%'` — and an example-based
test can only check the cases someone thought of. Three properties now hold that
claim to account: range membership is exactly prefix matching, `escapeLike`
round-trips (and leaves no unescaped metacharacter behind), and `tokeniseQuery`
never drops a `%`, `_` or `\` before `escapeLike` can neutralise it. All three
were true. They are mutation-checked rather than assumed: each goes red against
a deliberately broken variant, including the closed-vs-half-open range mutant
that the first generator missed, because no generated handle could land exactly
on the bound.

No new dependency: `fast-check` already ships inside `effect`, reached via
`effect/testing`. The handle generator is derived with `Schema.toArbitrary` from
the same `^[a-z0-9_]+$` pattern the source constrains itself to, so it restates
the constraint instead of duplicating it.

`shared/redis/src/ioredis.ts` replaces a hand-rolled `Promise.race` deadline
with `Effect.timeoutOrElse` — `timeoutOrElse`, not plain `timeout`, because the
latter widens the error channel to `RedisError | TimeoutError` and fails the
layer's declared `Layer.Layer<Redis, RedisError>`. The failure mode is
byte-identical: one `Fail` carrying `RedisError { cause: "Redis startup ping
timed out" }`. That matters more than it looks — the limiters fail closed, so a
changed timeout path surfaces as rejected requests rather than an obvious crash.

`health.ts` keeps its `Promise.race`: it is a bare `async function` on the
public barrel, awaited inside a `try/catch` by two composition roots that also
disconnect and rethrow, so converting it would either put a per-call
`Effect.runPromise` in a function with no `ManagedRuntime` — against the
build-the-layer-graph-once rule — or ripple through both `initRedisClient`
implementations and three test files.

Also adds the first test for `RedisLive` itself, which had none.
