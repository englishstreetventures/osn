---
"@osn/api": minor
"@osn/social": minor
"@osn/client": minor
"@osn/ui": minor
"@osn/db": minor
---

Security + UX hardening across the auth stack (review of PRs #315–#324).

**Identity / OIDC provider (`@osn/api`, `@osn/db`)**

- Pairwise-`sub` isolation: a self-serve OIDC client's sector is now its
  server-generated `client_id`, not the first redirect-URI host (attacker-chosen
  and unverified), so colluding clients can no longer share a sector to correlate
  the same user across apps.
- `auth_time` survives silent session rotation: sessions gain an immutable
  `authenticated_at` (new column, copied forward on every refresh), so a relying
  party's `max_age`/`prompt=login` reflects the real passkey ceremony instead of
  the last background token refresh.
- Consent-screen anti-impersonation: client names are NFKC-normalised, reject
  bidi/zero-width/control characters, and are blocked when they fold to a
  confusable skeleton of a first-party app name (Musubi, OSN, Pulse, Zap, Cire).
- Step-up tokens are bound to their ceremony purpose at every gate (passkey
  register/delete, email change, security-event ack), closing cross-ceremony
  replay of a still-unconsumed token.
- Destructive passkey routes fail closed (409) on a presented-but-stale session
  binding instead of degrading to an account-wide session wipe (S-M2).
- Minor OIDC hardening: generic token-endpoint errors (no internal cause on the
  wire), RFC 9207 `iss` on authorization responses, required browser-binding on
  every parked request (S-L4), a total-rows cap on client registration, and a
  branded HTML error page for pre-validation `/authorize` failures.

**Client + UI (`@osn/client`, `@osn/ui`, `@osn/social`)**

- New OIDC connections SDK; Settings → "Connected apps" now lists and revokes
  real connections (GDPR Art. 7(3)) instead of a hardcoded list.
- The security-events banner is mounted (recovery-code generate/consume events
  now reach the user in-app), and the consent screen surfaces a verifiable
  identity signal (verified-app badge / third-party redirect host).
- Consent UX: a `login_required` re-auth loop is capped, the profile picker gets
  a decline path, and a trailing-slash `/authorize/` no longer escapes the bare
  layout. CSP tightened (object-src/base-uri/form-action).
- Recovery codes are guarded against silent loss on navigation after the old set
  is revoked; the rotation warning uses the component-library dialog; the
  step-up dialog explains why re-auth is needed; a failed passkey ceremony maps
  to an actionable recovery message.
