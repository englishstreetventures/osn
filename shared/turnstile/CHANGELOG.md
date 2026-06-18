# @shared/turnstile

## 0.2.0

### Minor Changes

- d81383d: Add Cloudflare Turnstile bot protection to the OSN auth surface (key-optional, fail-closed).

  New `@shared/turnstile` package exposes `createTurnstileVerifier(secret?)` — a key-optional, fail-closed siteverify helper. When the `TURNSTILE_SECRET_KEY` secret is **unset** the verifier is `null` and every gate is skipped (flows behave exactly as before — safe to merge before the widget exists). When **set**, it POSTs the token to Cloudflare's managed `siteverify` endpoint via `instrumentedFetch`, passing the caller's `cf-connecting-ip` as `remoteip`, and rejects on any missing / invalid / expired / duplicate (single-use) token or unreachable endpoint. The secret is never logged or returned to the client.

  - **`@osn/api`**: `/register/begin` and `/login/passkey/begin` are gated. The verifier is built once per isolate in `build-deps.ts` from `env.TURNSTILE_SECRET_KEY` and threaded through `createAuthRoutes`; a configured gate fails closed with `400 turnstile_failed`. New bounded metric `osn.auth.turnstile.rejected{endpoint}`.
  - **`@osn/client`**: `RegistrationClient.beginRegistration` and `LoginClient.passkeyBegin` accept an optional `turnstileToken`, sent on the begin call (omitted cleanly when absent — the no-Turnstile call shape is unchanged, and the silent conditional-UI passkey ceremony carries no token).
  - **`@osn/ui`**: new `TurnstileWidget` (Solid) renders Cloudflare's widget only when a `siteKey` prop is provided (lazy-loads `api.js`, `data-action="turnstile-spin-v1"`); `Register` + `SignIn` take an optional `turnstileSiteKey` prop and gate submit on a solved challenge. Omitted ⇒ no widget, no gate.

  The sitekey is public (embedded in client HTML at build time via `PUBLIC_TURNSTILE_SITEKEY`); the secret is a `wrangler secret` on osn-api. Both halves are optional and graceful, mirroring the maps-embed key and `OSN_EMAIL_OPTIONAL` precedents.

### Patch Changes

- Updated dependencies [5055e1a]
- Updated dependencies [130e6c5]
  - @shared/observability@0.11.0
