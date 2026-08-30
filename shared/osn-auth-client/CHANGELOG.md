# @shared/osn-auth-client

## 0.4.12

### Patch Changes

- @shared/crypto@0.10.11

## 0.4.11

### Patch Changes

- e382c40: Enforce the access-token `issuer` claim in every downstream verifier.

  `@shared/osn-auth-client` has always accepted an expected `iss`, but every consumer left it unset — deliberately, because a verifier that pins the issuer rejects every token minted before osn-api started stamping one, and the rollout had to be verifier-first. Access tokens live five minutes, so that window closed long ago: every live token carries `iss`, and leaving the check off means a token from any other OSN deployment verifies here as long as it is signed by a key that deployment's JWKS vouches for.

  `cire/api`, `pulse/api` and `zap/api` now pass the expected issuer on every `extractClaims` call. In pulse and zap the JWKS URL and the issuer travel as one `OsnTokenVerification` value rather than two loose strings, so a call site cannot supply one and silently forget the other — which is the failure mode that left this unenforced, since an unset expected issuer is not an error, it is simply no check.

  `OSN_ISSUER_URL` is now required in a deployed tier and must equal osn-api's own value byte for byte; a mismatch 401s every authenticated request, so the two flip in the same deploy. `zap/api` gains the var, which it did not read before. `@shared/crypto/testing`'s signer stamps the local issuer by default, so a suite that injects a test key mints tokens its routes accept; pass a different origin, or `null`, to exercise the rejection paths.

  Three things fell out of reviewing it. `extractClaims` now treats an expected issuer that is present but **empty** as a configuration failure rather than as "no issuer check" — an unset env var reaching the verifier was the one way this could look configured while checking nothing. The comparison normalises a trailing slash on both sides, since six hand-maintained `wrangler.toml` values feed it and `jose` compares byte for byte. And `zap/api` gains `OSN_ISSUER_URL`/`OSN_JWKS_URL` in the portless devloop, which it never had — every bearer-authenticated zap route was 401ing locally, and pinning the issuer is what made that visible.

- Updated dependencies [e382c40]
  - @shared/crypto@0.10.10

## 0.4.10

### Patch Changes

- @shared/crypto@0.10.9

## 0.4.9

### Patch Changes

- Updated dependencies [8fac137]
  - @shared/crypto@0.10.8

## 0.4.8

### Patch Changes

- ee304e6: Require an `exp` claim when verifying an access or step-up token. `jose`
  validates expiry only when the claim is present, so a token minted without one
  verified for as long as the signing key lived — no expiry, and neither verifier
  looks at token age by any other route. The issuer always sets `exp` (5 minutes
  for access tokens), so requiring it rejects nothing that was ever meant to work.

## 0.4.7

### Patch Changes

- b219759: Dependency review: drop unused `better-sqlite3`, align stale peer ranges, bump oxfmt

  - `@shared/db-utils` no longer declares `better-sqlite3` or `@types/better-sqlite3`.
    Neither was imported by `src/` or `tests/` — the package has no drizzle-kit and no
    `db:*` scripts, so nothing there ever loaded the native module. The three `*/db`
    workspaces that do run drizzle-kit against a local SQLite file — `osn/db`,
    `pulse/db`, `zap/db` — keep theirs.
  - `@shared/osn-auth-client` peer `elysia` `^1.4.28` → `^1.4.29`, matching the range
    every other workspace declares.
  - `@shared/rp-auth` peer `solid-js` `^1.9.13` → `^1.9.14`, likewise. Both peers already
    resolved to the same version; this only stops the ranges drifting further apart.
  - Root `oxfmt` `^0.59.0` → `^0.62.0`. 0.62.0 changes how a type-annotated arrow return
    is wrapped, which reformats one file in `@pulse/api`
    (`src/services/events.ts`) — whitespace only, no behaviour change.
  - `fast-uri` dropped from `minimumReleaseAgeExcludes` in `bunfig.toml`. It was added
    for the GHSA-v2hh-gcrm-f6hx fix in 3.1.4, which shipped inside the 3-day install
    gate. The override now pins `^3.1.5` and 3.1.5 shipped 2026-07-31, so the entry
    had stopped protecting anything and was exempting every future 3.x publish.
  - @shared/crypto@0.10.7

## 0.4.6

### Patch Changes

- Updated dependencies [7a75d6c]
  - @shared/crypto@0.10.6

## 0.4.5

### Patch Changes

- Updated dependencies [2440ea9]
  - @shared/crypto@0.10.5

## 0.4.4

### Patch Changes

- @shared/crypto@0.10.4

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

- 587f561: Clear every `anti-slop/no-conditional-empty-object-spread` hit in application
  source and raise the rule from `warn` to `error`. A `...(cond ? { k: v } : {})`
  inside an object literal hides an omitted property in the middle of a shape, so
  the reader has to run the condition in their head to know what the object
  actually holds. Each of the 56 sites is now a named binding built in statements,
  with the optional field added after.

  Most were option bags handed to a constructor: `cire/api/src/index.ts` and both
  Pulse entrypoints (`index.ts`, `local.ts`) now build a typed `AppOptions` and
  set the origin, limiter and login-URL fields conditionally, which also makes the
  comment explaining each one sit next to the assignment instead of inside a
  ternary. `shared/crypto/src/arc.ts` and `shared/osn-auth-client/src/verify.ts`
  build a `JWTVerifyOptions` the same way, so the "unset issuer means jose does
  not enforce `iss`" rule (X2) is a single readable line.

  The rest are wire payloads and drizzle update sets. `pulse/api`'s series
  instance update was thirteen consecutive conditional spreads; it is now thirteen
  `if` statements over a `Partial<typeof events.$inferInsert>`, same thirteen keys.
  `guest-event-draft.ts`, `spreadsheet.ts`, `import.ts` and `zap-bridge.ts` follow
  the same shape. `organiser-hosts.ts` gains `HostPersonDto` and `HostSeatDto`, so
  the co-host panel's response is a named type rather than an inline literal with
  four conditional keys.

  Two fixes in `osn/api/src/services/auth/step-up.ts` beyond the rule: the claims
  object reuses the exported `StepUpTokenClaims` instead of redeclaring it, and it
  is built inside the `Effect.tryPromise` thunk so a throw still maps to
  `AuthError`.

  Test files still hold 25 hits, all fixture builders folding an optional argument
  into a request body, so the rule stays off in the test override.

- 1ddf9bb: Clear every `anti-slop/no-unsafe-dictionary-type` hit in application source and
  raise the rule from `warn` to `error`. `Record<string, unknown>` says only "an
  object with string keys" — it accepts any key, guarantees no field, and hides
  whichever shape the code actually meant. Each of the 67 hits was one of four
  things, and each got a different fix.

  **A shape that was always known.** `@shared/crypto` exports an `Es256Jwk`
  interface and `validateEs256Jwk` asserts against it, so `importKeyFromJwk` takes
  `unknown` and does the checking itself instead of trusting a caller's cast —
  `@osn/api`'s boot path now hands it the raw string. `@osn/api`'s auth helpers
  name the four claim sets it signs (`AccessTokenClaims`, `StepUpTokenClaims`,
  `IdTokenClaims`, `OidcAccessTokenClaims`), and `verifyJwt` returns a
  `VerifiedJwtClaims` whose every field stays `unknown` on purpose: one key signs
  all four sets, so callers must still narrow on `aud`. `@pulse/api`'s account
  export becomes a discriminated union on `section`, so a reader that switches on
  the tag knows exactly which record fields it has.

  **A drizzle update set.** `@osn/api`'s organisation update and both `@cire/api`
  registry updates are typed `Partial<typeof table.$inferInsert>`, so a key that
  isn't a column fails at the assignment rather than at the D1 boundary.
  `@shared/db-utils` replaces seven `S extends Record<string, unknown>` schema
  constraints with a real `DrizzleSchema`.

  **An untrusted payload.** The CSP report normaliser, the osn-bridge org
  decoder, the crop validator and the guest claim-response guard now name the
  wire shape with every field left `unknown`, or narrow with `in` and drop the
  stand-in type entirely. Nothing gains a guarantee the wire never made.

  **A cast that was hiding a working type.** `@shared/feature-flags` uses
  GrowthBook's own `FeatureDefinitions` / `SavedGroupsValues`, which removes the
  `payload as never` at `initSync`. `@shared/observability`'s redactor and
  `@shared/openapi-tools`' normaliser drop casts their narrowing had already
  earned; `generate.ts` now throws on a non-object OpenAPI document instead of
  asserting one. `@osn/api`'s public-error walker reads through
  `Object.getOwnPropertyDescriptor` rather than indexing a widened object.

  Test files still hold 102 hits — nearly all a stub request body or a drizzle row
  the test then asserts on field by field — so the rule stays off in the test
  override.

- Updated dependencies [587f561]
- Updated dependencies [c87ea88]
- Updated dependencies [1ddf9bb]
  - @shared/crypto@0.10.3

## 0.4.2

### Patch Changes

- Updated dependencies [d50c68e]
  - @shared/crypto@0.10.2

## 0.4.1

### Patch Changes

- @shared/crypto@0.10.1

## 0.4.0

### Minor Changes

- 1c19bae: Move the OIDC relying-party server half out of cire and into the shared
  packages, so a second product can sign users in with an OSN account without
  copying four files.

  Three new entry points, all lifted verbatim from `cire/api` with the
  product-specific parts turned into parameters:

  - `@shared/crypto/tokens` — opaque token minting plus the SHA-256 hash stored
    at rest, the primitive behind every server-side session in the monorepo.
  - `@shared/osn-auth-client/cookie` — the `Set-Cookie` builder and request-cookie
    parser. Host-scoped by construction: no `Domain=` attribute, so the cookie
    never widens to sibling subdomains. `SameSite=Lax` is required rather than
    merely tolerated — the OIDC callback arrives as a top-level cross-site GET,
    which `Strict` would strip the transaction cookie from.
  - `@shared/osn-auth-client/oidc-rp` — `beginLogin` / `completeLogin` /
    `readReturnTo`, the PKCE transaction cookie, and the ID-token checks. A token
    without an `osn_profile_id` claim is refused outright; client authentication
    is `client_secret_post`, never Basic.
  - `@shared/osn-auth-client/testing/oidc-issuer` — the fake issuer the flow is
    tested against, now product-neutral, with the return origin passed in.

  `OidcConfig` gains a required `txHmacInfo`: the HKDF `info` the transaction
  cookie's MAC key is derived under. It is required, not defaulted, because two
  products sharing an OIDC client secret would otherwise derive the same key, and
  one product's transaction cookie would verify at the other.

  No behaviour change for cire, which now imports all of the above.

### Patch Changes

- Updated dependencies [1c19bae]
  - @shared/crypto@0.10.0

## 0.3.5

### Patch Changes

- @shared/crypto@0.9.5

## 0.3.4

### Patch Changes

- Updated dependencies [4d5f815]
  - @shared/crypto@0.9.4

## 0.3.3

### Patch Changes

- @shared/crypto@0.9.3

## 0.3.2

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

- Updated dependencies [8226487]
  - @shared/crypto@0.9.2

## 0.3.1

### Patch Changes

- @shared/crypto@0.9.1

## 0.3.0

### Minor Changes

- 2b7a7f1: Support relying parties that sign people in through the OSN OIDC issuer.

  - `@shared/rp-auth` (new): the browser half of a relying party — `signInUrl`,
    `startSignIn`, `fetchSession`, `signOut`, `createAuthFetch`, `readAuthError`,
    `clearAuthError`, `isAuthExpired` and `AuthExpiredError`, plus an
    `AuthProvider`/`useAuth` pair on the `/solid` sub-path. Every request carries
    `credentials: "include"`, because the RP holds its own session cookie and the
    browser never sees an OSN token.
  - `@shared/osn-auth-client`: new `verifyIdToken` — signature over the issuer's
    JWKS, `iss`/`aud`/`exp`/`nonce` checks, and the claims a relying party reads.
  - `@shared/crypto`: `timingSafeEqual` moved here from `@osn/api`, so both sides
    of a code exchange can compare secrets without one importing the other.
  - `@osn/api`: ID tokens for first-party clients now carry an `osn_profile_id`
    claim holding the real `usr_*` profile id, so a first-party app can address a
    person by the same id the ARC routes use instead of the pairwise `sub`. The
    internal profile-organisations route returns full organisation summaries
    (`organisations`) rather than bare `organisationIds` — the public
    `/organisations` projection still has no id, which is why the caller needs
    this one.
  - `@osn/social`: the settings page reads and writes the URL fragment, so other
    apps can deep-link to `/settings#security`. Passkeys are bound to this
    origin's RP ID and can only be managed here.

### Patch Changes

- Updated dependencies [2b7a7f1]
  - @shared/crypto@0.9.0

## 0.2.11

### Patch Changes

- @shared/crypto@0.8.11

## 0.2.10

### Patch Changes

- @shared/crypto@0.8.10

## 0.2.9

### Patch Changes

- @shared/crypto@0.8.9

## 0.2.8

### Patch Changes

- @shared/crypto@0.8.8

## 0.2.7

### Patch Changes

- @shared/crypto@0.8.7

## 0.2.6

### Patch Changes

- f569c7c: Bound the JWKS negative cache and throttle forced refetches (amplification DoS).

  Two amplification vectors in the downstream token verifier:

  - The negative cache had no size cap, so an unauthenticated flood of tokens with
    random `kid`s grew the map without bound (heap-exhaustion DoS). It is now
    FIFO-bounded to NEGATIVE_CACHE_MAX_SIZE.
  - A valid-`kid`/bad-signature token forced an unconditional JWKS refetch, and
    because kids are public an attacker could drive one upstream fetch per
    request against the issuer's JWKS endpoint. Forced refetches are now throttled
    to at most once per kid per cooldown window; a genuine key rotation is still
    picked up by the first refetch in the window.

- Updated dependencies [f569c7c]
  - @shared/crypto@0.8.6

## 0.2.5

### Patch Changes

- @shared/crypto@0.8.5

## 0.2.4

### Patch Changes

- Updated dependencies [630e98f]
  - @shared/crypto@0.8.4

## 0.2.3

### Patch Changes

- Updated dependencies [f4b9c6b]
  - @shared/crypto@0.8.3

## 0.2.2

### Patch Changes

- @shared/crypto@0.8.2

## 0.2.1

### Patch Changes

- @shared/crypto@0.8.1

## 0.2.0

### Minor Changes

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

### Patch Changes

- 5e4c560: Remove the unused Hono middleware adapter and its `hono` devDependency. Every OSN consumer (osn, pulse, cire) uses the Elysia adapter; the Hono adapter was a type-only shim with no runtime user, and `hono` only existed in the dependency tree as a devDependency. Dropping it also clears the hono CORS advisory (GHSA-88fw-hqm2-52qc) from `bun audit`. A Hono adapter can be re-added if/when an external Hono consumer needs one.
- Updated dependencies [5055e1a]
  - @shared/crypto@0.8.0

## 0.1.3

### Patch Changes

- @shared/crypto@0.7.1

## 0.1.2

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

- 940561f: Split the pure ES256 key/JWK helpers into a DB-free entry point so the
  JWKS-verification path no longer drags in `bun:sqlite`.

  - `@shared/crypto`: pure ES256 key/JWK helpers (`importKeyFromJwk`,
    `generateArcKeyPair`, `exportKeyToJwk`, `thumbprintKid`, `ArcTokenError`)
    moved into a new DB-free `@shared/crypto/jwk` entry point. `arc.ts` and
    the barrel re-export them, so existing call sites are unchanged.
  - `@shared/osn-auth-client` imports `importKeyFromJwk` from
    `@shared/crypto/jwk` instead of the barrel — this severs the
    `arc.ts → @osn/db → bun:sqlite` chain from the JWKS-verification path so
    the cire Worker (which runs `osnAuth`) bundles without `bun:sqlite`.

- Updated dependencies [d04dc20]
- Updated dependencies [04e0bf2]
- Updated dependencies [940561f]
  - @shared/crypto@0.7.0

## 0.1.1

### Patch Changes

- @shared/crypto@0.6.12

## 0.1.0

### Minor Changes

- 1a4e9d5: Harden the shared OSN access-token verifier: treat expired/invalid
  tokens as terminal (no JWKS refetch), negative-cache unknown kids,
  coalesce concurrent JWKS fetches, and add a fetch timeout — removing a
  per-request upstream-fetch amplifier on every consumer. Fold the
  audience check into the single jwtVerify pass. Pulse routes now enforce
  aud=osn-access (previously any OSN-issued token authenticated).
- 051daa8: Extract OSN access-token verification + JWKS cache into a new shared
  package, `@shared/osn-auth-client`, with per-framework middleware
  adapters (Hono + Elysia). Pulse switches to consuming the shared
  verifier; cire will follow in a later phase.

### Patch Changes

- @shared/crypto@0.6.11
