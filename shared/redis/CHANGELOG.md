# @shared/redis

## 0.4.4

### Patch Changes

- 15fe22c: Validate the Upstash `eval` reply against the RESP value space before returning it, instead of trusting the HTTP boundary's claimed type. Matches the check the ioredis path already runs through `toRedisReply`.

## 0.4.3

### Patch Changes

- d4553ed: Clear every `anti-slop/no-chained-type-assertions` hit in application source and
  raise the rule from `warn` to `error`. A double assertion — `x as unknown as T` —
  tells the compiler to stop checking, so each of the 32 sites was either a type
  that could be stated honestly or a claim that was no longer true.

  Most were the second kind. `buildAppDeps` and `selectEmailLayer` now name the
  env vars they read instead of taking a loose string record, so the Workers `env`
  binding passes structurally with no cast at all. `UpstashLike` mirrors the
  `@upstash/redis` mutable array signature and the wrapper copies on the way in.
  `FLAGS` is widened once on the way out of the registry, which removes three
  casts and a `Widen` round-trip at every call site. `commitBatch` probes for
  `.batch()` with a type guard rather than asserting the driver has one.

  One was a live bug: `pulse/web`'s create-event form cast a `Date` to `string`
  and relied on `JSON.stringify` to serialise it on the way out. It now calls
  `toISOString()` where the conversion happens.

  Test files still hold 161 hits — mostly a fixture cast to the shape under test —
  so the rule stays off in the test override.

- c87ea88: Clear every `anti-slop/no-known-value-widening` hit in application source and
  raise the rule from `warn` to `error`. The rule fires when a value the compiler
  already knows the shape of — an object literal, an arrow function, a `new` —
  is annotated with something broad enough to throw that knowledge away:
  `unknown`, `object`, an inline type literal, or any `Record<K, V>`.

  Nearly all 116 hits were lookup tables annotated `Record<string, T>`. They split
  two ways, and the split is the whole substance of this change:

  **Closed-key tables** now carry a trailing `satisfies Record<ClosedUnion, T>`
  instead of a leading annotation. The table keeps its literal type, so a missing
  key is a compile error rather than a silent `undefined` at the read site — the
  opposite of what the `Record` annotation gave.

  **Genuinely open-key tables** — the ones read with a runtime string and a `??`
  fallback — now declare a named `interface` with an index signature. This states
  the real contract (any key may miss) where `Record<string, T>` claimed every key
  is present. It also avoids the alternative the first pass reached for, a
  `key as keyof typeof TABLE` assertion, which is unsound and would have added to
  the `require-safety-comment-for-type-assertion` backlog.

  Two of these were latent bugs. `selectAuthRateLimiters` assembled its bundle in
  a `Record<string, RateLimiterBackend>` and cast the result to
  `AuthRateLimiters`, so a missing limiter slot typechecked; it now builds into a
  mapped type with the `readonly` stripped and returns without a cast. `Icon`'s
  glyph table was annotated `Record<string, () => JSX.Element>`, which let a new
  `IconName` be added to the union with no glyph behind it; the `satisfies` now
  forces coverage while `name` stays a plain `string`, since an unrecognised name
  rendering nothing is the documented behaviour its tests assert.

  Return-type hits were handled by naming the shape. `satisfies` does not silence
  those — the rule unwraps it — so `initObservability` and friends now return an
  exported interface instead of an inline type literal.

  Test files still hold 62 hits, nearly all a fixture table or a stub response
  annotated `Record<string, …>` so the test can index it with a computed key, so
  the rule stays off in the test override.

- 9f1b272: Clear every `anti-slop/no-unknown-returns` hit in application source and raise
  the rule from `warn` to `error`. A function returning `unknown` hands its caller
  a value with no contract, so every site either had a shape worth naming or was
  returning a value nobody read.

  The three `arc-middleware.ts` copies (osn, pulse, zap) now decode a JWT segment
  to text and parse it through `parseArcHeader` / `parseArcPayload`, which narrow
  with `in` checks and contain no type assertions at all. `zap-bridge.ts` gains
  four named response types and a parser per endpoint, so a malformed zap-api
  reply throws at the bridge — naming the endpoint — instead of surfacing as an
  `undefined` field several layers up. `safe-error.ts` and `grant-failure.ts`
  share a `TaggedServiceError` guard in place of duck-typed shape checks.

  `shared/redis` exports a recursive `RedisReply` and narrows ioredis's `unknown`
  through `toRedisReply()` once, at the driver boundary. `shared/observability`'s
  redactor returns a `RedactedValue` union, and `shared/openapi-tools` normalises
  through a `JsonNode` union that throws on anything JSON cannot represent.
  `@osn/ui` exports `RunPasskeyCeremony` and `RunPasskeyRegistration` so the four
  step-up call sites name the ceremony callback instead of typing it
  `(options: unknown) => Promise<unknown>`, and `@osn/client`'s two registration
  begins return `PublicKeyCredentialCreationOptionsJSON`.

  Test files still hold 18 hits, all in fetch/JSON helpers, so the rule stays off
  in the test override.

## 0.4.2

### Patch Changes

- 8226487: Refresh dependencies across the monorepo (routine maintenance audit).

  Security-relevant: `@simplewebauthn/server` 13.3.0 → 13.3.2 closes
  GHSA-6hxq-p678-4hr2 (CVSS v4 Low 2.0), where a maliciously-crafted attestation
  `x5c` could present a self-signed "root certificate" rather than chaining to an
  RP-specified trust anchor. Reached through `verifyRegistrationResponse()` on the
  passkey registration path. Exposure was nil rather than merely limited: we
  configure no trust anchors anywhere, so `validateCertificatePath` short-circuits
  on `trustAnchorsPEM.length === 0` and no chain decision was ever made — in
  13.3.0 as much as in 13.3.2. Tracked as S-L102, which also records why
  `attestationType: "none"` is _not_ the control here.

  `jose` moves 6.2.3 → 6.2.4 only, which is a docs update plus an `exportJWK`
  refactor that drops `undefined`-valued properties. That change is inert for us:
  `exportKeyToJwk` immediately `JSON.stringify`s its result, and `thumbprintKid`
  feeds RFC 7638 canonicalisation over `kty`/`crv`/`x`/`y`, so existing `kid`s and
  stored JWKs are byte-identical. The JOSE input-validation hardening (Base64URL
  alphabet, UTF-8 in headers and claims, truncated ASN.1 key data, duplicate
  `crit`) is in **6.2.5**, which this branch does _not_ take — it published
  2026-07-29 and is inside the 3-day quarantine. That upgrade is tracked
  separately and matters, since `jose` sits under both ARC S2S tokens and the
  5-minute `osn-access` JWTs.

  `effect` 3.21.2 → 3.22.0 (deprecates `Graph.neighborsDirected`, unused here),
  with `@effect/vitest` 0.29 → 0.30 and `@effect/opentelemetry` 0.63 → 0.64
  following its `^3.22.0` peer. `@effect/platform` is now an explicit
  `@shared/observability` dependency at `^0.97.0`: it was previously auto-installed
  at 0.94.5 purely to satisfy `@effect/opentelemetry`'s peer and did not actually
  meet it.

  `oxlint` 1.70 → 1.76 makes `vitest/expect-expect` effective inside `it.effect`
  bodies for the first time — the rule was already configured with
  `additionalTestBlockFunctions`, but earlier versions never walked those blocks.
  Ten `@osn/api` tests (of 644) were relying on "the Effect didn't fail" as their
  only assertion; each now asserts the behaviour its name claims, with no change
  to what is under test.

  The `@opentelemetry/*` SDK packages are held at `~2.9.0` rather than moved to
  2.10.0. The exporters and `sdk-logs` cannot follow yet — 0.221.0 is inside the
  14-day minor window — and the 0.220.0 exporters pin `core`/`resources`/
  `sdk-metrics`/`sdk-trace` to exactly 2.9.0, so taking only the SDK half splits
  the tree across two lines and links 2.10.0 packages against `core@2.9.0`. The
  tilde is deliberate: `^2.9.0` still admits 2.10.0. The whole line moves together
  once the exporters are eligible (2026-08-04).

  The root `esbuild` override rises `^0.27.0` → `^0.28.1`, closing
  GHSA-g7r4-m6w7-qqqr. The override had inverted from protective to harmful:
  wrangler 4.114 pins `esbuild 0.28.1` — the fixed version — and the `^0.27.0`
  floor was clamping the whole tree back down to the vulnerable 0.27.7. astro
  already declares `^0.28.0`, so `^0.28.1` now agrees with both consumers instead
  of fighting either. `bun audit` reports no vulnerabilities.

  `oxfmt` 0.44 → 0.59 spans four breaking formatter changes, but produces no
  output change here: the `fmt` script already excludes CSS, astro and markdown,
  and the `sort_imports` reclassification of subpath imports matches nothing in
  the tree. `bun run fmt` is a no-op on the current sources and `fmt:check` is
  clean. 0.60/0.61 stay out until they clear the 14-day minor window.

  Everything else is a patch/minor bugfix bump with no migration steps.

## 0.4.1

### Patch Changes

- f57a201: Add an OpenID Connect provider to osn-api, so any app can recognise an OSN
  account without holding a passkey of its own.

  Passkeys bind to one domain and cannot be moved, so every product that wants
  its own sign-in either shares the identity domain or asks the user to enrol
  again. This is the way out: the ceremony stays on the identity domain, and
  other apps get there by redirect.

  Three endpoints and a discovery document:

  - `GET /authorize` — authorization code flow, PKCE with S256 only. Errors
    follow RFC 6749 §4.1.2.1: until the client and its redirect URI are both
    known good the error is rendered, never redirected, so the provider cannot
    be turned into an open redirect. `prompt=none|login|select_account|consent`
    all behave as the spec says.
  - `GET /authorize/context` and `POST /authorize/decision` — what the consent
    screen reads and writes. The request id is single use, so an approval
    cannot be replayed into a second code.
  - `POST /oidc/token` — code for tokens. One code, one exchange; the code is
    deleted as it is read. Public clients must present no secret, confidential
    clients may use `client_secret_basic` or the body, never both.

  Subjects are pairwise: each client sees a `sub` derived by HMAC from its own
  sector and the profile, so two clients cannot join their records by user id.
  Codes are stored hashed, as session tokens already are.

  New tables in `@osn/db`: `oauth_clients`, `oauth_authorization_codes`,
  `oauth_consents` (migration `0002_wet_gamora`).

  Four rate limiters and their metric attributes come along with it. Both
  shared packages change only to widen a closed union — no behaviour moves.

  Before the next non-local deploy, set `OSN_PAIRWISE_SALT` (32 bytes or more)
  as a Worker secret. The check is fail closed: without it osn-api will not
  boot outside local. Set `OSN_AUTHORIZE_UI_URL` once the consent screen has a
  home; it falls back to `/authorize` on the web origin.

  See `[[wiki/systems/oidc-provider]]`.

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
