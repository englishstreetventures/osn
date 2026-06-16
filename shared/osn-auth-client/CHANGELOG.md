# @shared/osn-auth-client

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
