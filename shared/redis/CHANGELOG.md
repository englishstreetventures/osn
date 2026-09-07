# @shared/redis

## 0.5.0

### Minor Changes

- d3af349: Move every Effect dependency to 4.0.0-rc.112 and convert the service keys.

  `effect`, `@effect/vitest` and `@effect/opentelemetry` are pinned to one exact
  version, because v4 releases the ecosystem under a single version number and is
  still pre-GA — a caret range would let an install move the target mid-migration.
  `@effect/platform` is dropped: v4 merged it into core, and nothing here imported
  it.

  `Context.Tag` no longer exists. Class declarations become
  `Context.Service<Self, Shape>()(id)` — note the argument order flips — and the
  `Context.Tag<any, A>` parameter types in `@shared/db-utils` become
  `Context.Key<any, A>`. Every service identifier string is unchanged, since those
  are the runtime lookup keys. Call sites are untouched: a v4 service key still
  extends `Effect`, so `yield* Db` works as before.

  This is the first phase of the Effect v4 migration and does not stand alone —
  the tree does not type-check until the `Schema` work lands.

### Patch Changes

- d3af349: Apply the Effect v4 combinator renames and the Cause/Runtime rework.

  Renames resolved from upstream's generated reference: `catchAllDefect` →
  `catchDefect`, `catchAllCause` → `catchCause`, `catchAll` → `catch`, `either` →
  `result`, `forkDaemon` → `forkDetach`, `zipRight` → `andThen`, `dieMessage` →
  `die(new Error(…))`, `Layer.scoped` → `Layer.effect`, `Cause.failureOption` →
  `Cause.findErrorOption`. The `Either` module became `Result`, whose variants are
  tagged `Success`/`Failure` and carry `success`/`failure` rather than
  `right`/`left`.

  `Runtime.isFiberFailure` and `FiberFailureCauseId` are gone: v4's runner rejects
  with `Cause.squash(cause)`, which is the typed failure itself, so the two
  osn-api error-shaping helpers no longer unwrap anything. That changes one thing
  on a security path — `Cause.squash` surfaces a _defect_ where v3's
  `Cause.failureOption` returned `None` — and both helpers now document it.

  Adds a test asserting the Redis layer's finalizer runs on scope close. The
  `Layer.scoped` → `Layer.effect` rewrite would have leaked connections silently
  if the scope had been dropped: it type-checks either way, and nothing covered it.

  Second phase of the Effect v4 migration; the tree does not type-check until the
  `Schema` work lands.

- d3af349: Pin the search string-math with property tests, and let Effect own the Redis
  startup deadline.

  `search.ts` states its invariants in doc comments as facts — `handlePrefixRange`
  claims to be _exactly equivalent_ to `handle LIKE 'q%'` — and an example-based
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

## 0.4.7

### Patch Changes

- afa5920: Take ioredis 6.0.0 (from 5.11.1). This is not a dev-only bump: `osn/api/src/index.ts` and `pulse/api/src/index.ts` both statically import `./redis`, which statically imports `@shared/redis/ioredis`, so ioredis is compiled into both deployed Worker bundles and its module body runs at isolate startup. v6 drops the `redis-parser` package for an in-tree RESP decoder — confirmed, `redis-parser` is gone from the lockfile.

  Verified by booting the real built bundle on workerd (`wrangler dev --local`), not by a dry run: `osn-api` starts clean and serves 200 on `/health`, `/.well-known/jwks.json` and `/`, with no errors in the log. The Worker bundle grows 4594.90 KiB to 4716.41 KiB.

  One thing the bundle growth understates, found while reviewing this bump and filed separately: the ioredis in these Worker bundles can never execute. `osn/api/src/index.ts` reaches it only through `initRedisClientFromEnv`, which on workerd selects Upstash-over-HTTP or the in-memory store; the socket-opening `createClientFromUrl` is reached solely from `osn/api/src/local.ts`. Stubbing that one import out and rebuilding puts ioredis at 449.58 KiB raw / 72.50 KiB gzip in `osn-api`, about 8.8% of the compressed script, parsed on every cold isolate start. That is pre-existing — it was 337.98 / 61.75 KiB gzip on ioredis 5 — and this bump adds 111.60 / 10.75 to it. The fix is a module split in `@shared/redis`, not a change to this bump.

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

## 0.4.6

### Patch Changes

- e9ba055: Narrow Upstash GET, PING and DEL replies at the HTTP boundary so a wrapper that hands back a non-string or non-integer fails with a message naming the adapter, command and arriving type instead of a TypeError further downstream. Send EVALSHA after the first EVAL of a script, keeping the digest per client and reloading the body only on NOSCRIPT. Skip rebuilding an EVAL array reply when every element is already a RESP value.

## 0.4.5

### Patch Changes

- c6d023b: Validate the Upstash `eval` reply against the RESP value space before returning it, instead of trusting the HTTP boundary's claimed type. Matches the check the ioredis path already runs through `toRedisReply`.

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
