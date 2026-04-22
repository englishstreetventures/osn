---
"@osn/api": minor
"@osn/db": minor
"@osn/client": minor
"@osn/ui": minor
"@shared/observability": patch
---

M-PK: passkey-primary prerequisites — passkey management surface + discoverable-credential login.

**Features**
- `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (step-up gated) — list, rename, remove credentials from Settings.
- Discoverable-credential / conditional-UI passkey login. `POST /login/passkey/begin` accepts an empty body and returns `{ options, challengeId }`; clients round-trip the challenge ID to `/login/passkey/complete`.
- `last_used_at` tracking on every assertion + step-up ceremony (60s coalesce).
- WebAuthn enrolment tightened to `residentKey: "required"` + `userVerification: "required"`.
- Hard cap of 10 passkeys per account (P-I10), enforced at both `begin` and `complete`.
- New `SecurityEventKind` `passkey_delete` — audit row + out-of-band notification, same pattern as recovery-code generate/consume.
- Last-passkey lockout guard: `DELETE /passkeys/:id` refuses the final credential unless recovery codes exist.
- New `@osn/client` surface `createPasskeysClient`; `@osn/ui/auth/PasskeysView` settings panel.
- `SignIn` opportunistically invokes `navigator.credentials.get({ mediation: "conditional" })` on mount when supported.

**Breaking**
- Removed the legacy unverified `POST /register` HTTP endpoint — use `/register/begin` + `/register/complete`.
- `LoginClient.passkeyComplete` now takes `{ identifier | challengeId, assertion }` instead of positional args.
- `AuthMethod` attribute union dropped `"password"` (OSN is passwordless).

**DB**
- Migration `0007_passkey_management.sql` adds `label`, `last_used_at`, `aaguid`, `backup_eligible`, `backup_state`, `updated_at` columns to `passkeys` (all nullable).

**Observability**
- New span names `auth.passkey.{list,rename,delete}`.
- New counter `osn.auth.passkey.operations{action, result}`.
- New histogram `osn.auth.passkey.duration{action, result}`.
- New counter `osn.auth.passkey.login_discoverable{result}`.
- `SecurityInvalidationTrigger` extended with `passkey_delete`.
- Log redaction deny-list adds `attestation`, `passkeyLabel`/`passkey_label`.
