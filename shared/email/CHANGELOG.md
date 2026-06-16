# @shared/email

## 0.2.6

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

- Updated dependencies [d04dc20]
- Updated dependencies [04e0bf2]
  - @shared/observability@0.10.1

## 0.2.5

### Patch Changes

- Updated dependencies [c3cca40]
  - @shared/observability@0.10.0

## 0.2.4

### Patch Changes

- Updated dependencies [9f6874b]
  - @shared/observability@0.9.2

## 0.2.3

### Patch Changes

- Updated dependencies [073238d]
  - @shared/observability@0.9.1

## 0.2.2

### Patch Changes

- Updated dependencies [9de67a2]
  - @shared/observability@0.9.0

## 0.2.1

### Patch Changes

- ac7312b: Add cross-device login: QR-code mediated session transfer allowing authentication on a new device by scanning a QR code from an already-authenticated device.
- Updated dependencies [ac7312b]
  - @shared/observability@0.8.1

## 0.2.0

### Minor Changes

- d431e9d: Switch email transport from Worker-proxy to Cloudflare Email Service REST API.

  `@shared/email` `CloudflareEmailLive` now POSTs directly to `https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send` with a bearer token. Removes the ARC-token-signing intermediary and the `@shared/crypto` dependency. Error reason `worker_unreachable` renamed to `api_unreachable`.

  `@osn/email-worker` is deleted — the Cloudflare Worker middleman is no longer needed since the REST API is available from any runtime, not just Workers.

  `@osn/api` replaces `OSN_EMAIL_WORKER_URL` with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` env vars.
