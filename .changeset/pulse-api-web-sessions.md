---
"@pulse/api": minor
"@pulse/db": minor
---

Sign a browser in to Pulse with an OSN account, over OIDC.

Pulse web could not sign anyone in. A passkey ceremony only runs on an origin
same-site with the WebAuthn RP ID, which is now `musubi.social`, so no Pulse
origin can mint an OSN credential. Pulse becomes a plain OIDC relying party
instead: the browser bounces to the issuer, comes back with a code, and leaves
with a Pulse session of its own.

- `pulse_web_sessions`: opaque tokens, SHA-256 hashed at rest, seven-day TTL,
  keyed on the `usr_*` profile id rather than the pairwise `sub`.
- `GET /api/auth/oidc/start` and `/oidc/callback` for the two legs, plus
  `GET /api/auth/session` (200 `{ signedIn: false }` for a visitor, never a 401)
  and `POST /api/auth/signout` (idempotent; `?all=1` clears every browser).
- Every authenticated route now accepts either credential. A bearer token is
  checked first and decides the request outright — present-but-invalid is a
  rejection, never a fall back to whoever the cookie names. The iOS app is
  untouched and never pays for the cookie lookup.
- `GET /api/close-friends/candidates` returns the caller's OSN connections
  with handle, name and avatar. The picker used to read the graph straight
  from the issuer with a bearer token; a browser has no OSN token to do that
  with, so Pulse fans the two S2S bridge calls out server-side instead.
- The session cookie is host-scoped, `HttpOnly`, `SameSite=Lax`, with no
  `Domain=`. Cookie credentials make Pulse writes CSRF-eligible for the first
  time, so an origin guard covers state-changing requests — it fires only when
  the session cookie is present, because the native app sends no `Origin`.

Deploy note: the API must be served from a host same-site with the web origin
(`api.<pulse-domain>`), or the browser will not send the session cookie back.
