# @shared/redis

## 0.4.0

### Minor Changes

- aed9d98: Add a Workers-compatible Upstash REST Redis backend (migration Phase 2).

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

### Patch Changes

- 5055e1a: OSN core auth hardening (W6):

  - **O1 — issuer pinning + clock tolerance.** Access and step-up JWTs are now
    signed with `iss = AuthConfig.issuerUrl` and verified with `issuer` pinned +
    a 30s `clockTolerance` at every verify site (local signer + verifier half;
    the downstream `@shared/osn-auth-client` verifier is W7). Rollout is
    verifier-first: the tolerant verifier must deploy before the signer enforces
    `iss`.
  - **O2 — recovery-code per-account lockout.** `consumeRecoveryCode` now counts
    failed attempts keyed on the RESOLVED accountId (threshold 5, 15-min
    lockout), Redis-backed with an in-memory fallback. Lockout returns the same
    generic error (no enumeration oracle), writes a `recovery_code_lockout`
    security-event row, and resets on success. Unknown identifiers never lock a
    victim.
  - **O3 — full Redis ceremony-store epic.** Every process-local ceremony /
    pending-state store (registration + login + step-up challenges, pending
    registrations, step-up OTP, pending email changes, cross-device requests) now
    has an injectable Redis-backed implementation alongside the in-memory default,
    plus the two per-account caps (profile-switch, email-change-begin) routed
    through the rate-limiter family. New `RedisNamespace` metric union in
    `@shared/redis` and per-namespace store telemetry.
  - **O4 — passkey-register cookieless fix.** `completePasskeyRegistration` now
    invalidates ALL account sessions (with a logged anomaly + invalidation
    metric) when no caller session is resolvable, instead of silently skipping
    H1 invalidation.
  - **O5 — randomised enumeration-probe sentinels.** The fixed `acc_enum_probe` /
    `__nonexistent__` burn-in keys are now per-request random non-matching ids.

  `@shared/observability` adds the `recovery_code_lockout` security-event kind.

- 5055e1a: Harden shared crypto / auth-client issuer handling (W7).

  - `@shared/crypto` `verifyArcToken` gains an optional `expectedIssuer` argument
    (X1). When set, jose enforces the signed `iss`, cryptographically binding the
    token issuer to the `kid`→issuer DB mapping. The OSN ARC middleware now passes
    the peeked issuer so a token whose `iss` differs from its `kid`'s registered
    service is rejected at verification time. Pulse's in-memory ARC receiver
    passes the registered issuer too (its explicit post-verify `iss` check is kept
    as defence-in-depth). Backward compatible — omitting the argument leaves `iss`
    unenforced.
  - ARC token cache key now includes the requested `ttl` and a canonicalised
    scope (X3), so a token requested with a shorter TTL never reuses a
    longer-lived cached entry and formatting-only scope differences collapse onto
    one entry. Scope is not sorted (differing scope order stays distinct, matching
    the signed claim).
  - The ARC public-key cache TTL is now overridable via
    `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS` (default 300), bounding the cross-process
    key-revocation window (X4).
  - `@shared/osn-auth-client` `extractClaims` / `osnAuth` adapters gain an optional
    `issuer` option and apply a 30s `clockTolerance` (X2). Issuer is optional and
    unset by default for rollout safety — when unset, `iss` is not enforced so
    pre-issuer-stamping access tokens still verify. An issuer mismatch is terminal
    (no JWKS refetch).
  - `@shared/redis` in-memory client `eval` now asserts it is only ever handed the
    rate-limit Lua script (X5), so a future, semantically-different script cannot
    silently inherit fixed-window rate-limit behaviour.

## 0.3.1

### Patch Changes

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

## 0.3.0

### Minor Changes

- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

### Patch Changes

- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).

## 0.2.2

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.1

### Patch Changes

- 19c39ba: feat(redis): wire up Redis-backed rate limiters (Phase 3)

  - Add `createRedisAuthRateLimiters()` and `createRedisGraphRateLimiter()` factories
    in `@osn/core` that build Redis-backed rate limiters from a `RedisClient`
  - Add `createClientFromUrl()` to `@shared/redis` so consumers don't need ioredis
    as a direct dependency
  - Wire env-driven backend selection in `@osn/app`: `REDIS_URL` set → Redis with
    startup health check; unset → in-memory fallback; graceful degradation on
    connection failure
  - All 12 rate limiters (11 auth + 1 graph) now use Redis when available
  - Resolves S-M2 (rate limiter resets on restart) for production deployments

## 0.2.0

### Minor Changes

- 115688b: feat(redis): add @shared/redis package (Phase 2 of Redis migration)

  New `@shared/redis` workspace with Effect-based Redis service for rate limiting and auth state stores:

  - `RedisClient` interface with ioredis adapter (`wrapIoRedis`) and in-memory fallback (`createMemoryClient`)
  - `Redis` Effect Context.Tag with `RedisLive` (ioredis + REDIS_URL) and `RedisMemoryLive` (dev/test) layers
  - `createRedisRateLimiter` — atomic INCR + PEXPIRE Lua script, fail-closed posture (S-M36)
  - `checkRedisHealth` — PING-based health probe with configurable timeout
  - `RedisError` tagged error (`Data.TaggedError`)
  - 13 tests covering rate limiter (atomicity, window expiry, key independence, fail-closed), health probe, and Effect service layer
