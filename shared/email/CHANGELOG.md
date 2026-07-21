# @shared/email

## 0.4.0

### Minor Changes

- 945702c: Add enquiry transactional templates (enquiry-new, enquiry-reply, enquiry-quote) for cire Vendors S4 enquiries.

## 0.3.4

### Patch Changes

- 6a38d0f: Add `org:read` to the register-service permitted-scopes allowlist in `@osn/api` so downstream services (cire-api) can resolve OSN org membership over ARC for the Vendors feature. Add the `vendor-claim-invite` transactional email template to `@shared/email` (fail-soft: sent on claim-token minting; missing `RESEND_API_KEY` degrades to a logged no-op).

## 0.3.3

### Patch Changes

- Updated dependencies [6b14961]
  - @shared/observability@0.12.0

## 0.3.2

### Patch Changes

- Updated dependencies [630e98f]
  - @shared/observability@0.11.2

## 0.3.1

### Patch Changes

- Updated dependencies [5d6a97c]
  - @shared/observability@0.11.1

## 0.3.0

### Minor Changes

- 0880d75: Add Resend as osn-api's preferred transactional-email transport.

  `@shared/email` gains `ResendEmailLive` (`makeResendEmailLive`) — POSTs to Resend's HTTP API (`https://api.resend.com/emails`, bearer-authed), works on workerd with no paid Workers plan. It reuses the exact template/render path of `CloudflareEmailLive` and matches its instrumented-fetch, span, metric, and non-2xx → tagged-failure semantics (429 → `rate_limited`, other non-2xx → `dispatch_failed`, fetch reject → `api_unreachable`). The `RESEND_API_KEY` is placed only in the `Authorization` header — never in a URL, span/metric attribute, log, or `EmailError.cause`.

  `osn/api`'s `selectEmailLayer` now prefers Resend: precedence is **Resend → Cloudflare (legacy fallback) → local Log → `OSN_EMAIL_OPTIONAL` Noop → throw**. `RESEND_API_KEY` is added to the Worker `Env` type. Key-optional / non-breaking: with no key, behaviour is exactly as before. With Resend configured, `OSN_EMAIL_OPTIONAL` is no longer needed (a future Resend outage then fails closed like any normal misconfig).

## 0.2.7

### Patch Changes

- f2c1351: Allow osn-api to boot in non-local environments WITHOUT Cloudflare email as an explicit opt-in.

  By default osn-api still fails closed at startup when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` are absent in a non-local env. Setting the new non-secret boolean `OSN_EMAIL_OPTIONAL=true` now lets it boot with a no-op email transport (`makeNoopEmailLive` in `@shared/email`) that discards transactional mail and emits a loud, redacted startup warning instead of throwing. Cloudflare creds always win when present. Transport selection is centralised in `osn/api/src/lib/email-layer.ts` (shared by the Bun and Workers entries).

- Updated dependencies [5055e1a]
- Updated dependencies [130e6c5]
  - @shared/observability@0.11.0

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
