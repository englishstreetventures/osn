# @shared/osn-auth-client

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
