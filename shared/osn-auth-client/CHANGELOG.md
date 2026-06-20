# @shared/osn-auth-client

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
