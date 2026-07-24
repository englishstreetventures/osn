---
"@osn/api": minor
"@osn/db": minor
"@shared/observability": patch
"@shared/redis": patch
---

Add an OpenID Connect provider to osn-api, so any app can recognise an OSN
account without holding a passkey of its own.

Passkeys bind to one domain and cannot be moved, so every product that wants
its own sign-in either shares the identity domain or asks the user to enrol
again. This is the way out: the ceremony stays on the identity domain, and
other apps get there by redirect.

Three endpoints and a discovery document:

- `GET /authorize` — authorization code flow, PKCE with S256 only. Errors
  follow RFC 6749 §4.1.2.1: until the client and its redirect URI are both
  known good the error is rendered, never redirected, so the provider cannot
  be turned into an open redirect. `prompt=none|login|select_account|consent`
  all behave as the spec says.
- `GET /authorize/context` and `POST /authorize/decision` — what the consent
  screen reads and writes. The request id is single use, so an approval
  cannot be replayed into a second code.
- `POST /oidc/token` — code for tokens. One code, one exchange; the code is
  deleted as it is read. Public clients must present no secret, confidential
  clients may use `client_secret_basic` or the body, never both.

Subjects are pairwise: each client sees a `sub` derived by HMAC from its own
sector and the profile, so two clients cannot join their records by user id.
Codes are stored hashed, as session tokens already are.

New tables in `@osn/db`: `oauth_clients`, `oauth_authorization_codes`,
`oauth_consents` (migration `0002_wet_gamora`).

Four rate limiters and their metric attributes come along with it. Both
shared packages change only to widen a closed union — no behaviour moves.

Before the next non-local deploy, set `OSN_PAIRWISE_SALT` (32 bytes or more)
as a Worker secret. The check is fail closed: without it osn-api will not
boot outside local. Set `OSN_AUTHORIZE_UI_URL` once the consent screen has a
home; it falls back to `/authorize` on the web origin.

See `[[wiki/systems/oidc-provider]]`.
