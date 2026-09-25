---
"@cire/api": patch
---

Test the organiser routes with the credentials a real caller sends. Tests
only; no runtime change.

- `makeOsnTestAuth().sign` now takes the same optional claims as the shared
  signer, so a cire test can mint an expired, foreign-issuer or wrong-audience
  bearer token. `GET /api/organiser/weddings` gains expired-bearer and
  wrong-audience 401 cases, and the one-purpose `signAsOtherIssuer` is gone.
- `POST /changes/preview` and `/apply` are now tested with the
  `cire_org_session` cookie and no bearer: a live session writes; a cookie
  naming no session, or an expired one, gets 401; a non-member's cookie gets
  403 from the wedding gate; and a live cookie from a foreign `Origin` gets 403
  from the origin guard with nothing staged. Two more cases send a cookie and a
  bearer together: a live cookie wins over the bearer, and a cookie naming no
  session falls through to it.
- New `tests/test-helpers/organiser-session.ts` → `seedOrganiserSession()`
  mints a session the way the OIDC callback does. `internal-revoke.test.ts`
  now uses it in place of its own copy.
