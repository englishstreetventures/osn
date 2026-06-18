---
"@osn/api": patch
---

Wire the `cireweddings.com` custom domain into osn-api's production config. OSN
identity runs under the cireweddings.com zone for now (a dedicated OSN domain is
deferred). In `osn/api/wrangler.toml` `[env.production]`:

- `OSN_RP_ID = "cireweddings.com"` — the WebAuthn RP ID is the registrable apex
  shared by the organiser portal (`app.cireweddings.com`), the only prod passkey
  surface. Prod passkeys are now UNBLOCKED (previously deferred pending a domain).
- `OSN_ORIGIN = "https://app.cireweddings.com"` — the organiser portal is the
  passkey origin.
- `OSN_ISSUER_URL = "https://id.cireweddings.com"` (JWT `iss`).
- `OSN_CORS_ORIGIN = "https://app.cireweddings.com"` — only the organiser portal
  calls osn-api; an empty list throws at boot.
- `OSN_EMAIL_FROM = "noreply@cireweddings.com"`.
- A custom-domain route `[[env.production.routes]]` (`pattern =
  "id.cireweddings.com"`, `custom_domain = true`) serving the Worker on
  `id.cireweddings.com` — auto-provisions DNS + cert since the zone is in-account.

Config-only; no app logic changed. dev/staging keep their current config. Validated
with `wrangler deploy --env production --dry-run`.
