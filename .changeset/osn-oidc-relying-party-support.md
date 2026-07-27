---
"@shared/osn-auth-client": minor
"@shared/rp-auth": minor
"@shared/crypto": minor
"@osn/api": minor
"@osn/social": patch
---

Support relying parties that sign people in through the OSN OIDC issuer.

- `@shared/rp-auth` (new): the browser half of a relying party — `signInUrl`,
  `startSignIn`, `fetchSession`, `signOut`, `createAuthFetch`, `readAuthError`,
  `clearAuthError`, `isAuthExpired` and `AuthExpiredError`, plus an
  `AuthProvider`/`useAuth` pair on the `/solid` sub-path. Every request carries
  `credentials: "include"`, because the RP holds its own session cookie and the
  browser never sees an OSN token.
- `@shared/osn-auth-client`: new `verifyIdToken` — signature over the issuer's
  JWKS, `iss`/`aud`/`exp`/`nonce` checks, and the claims a relying party reads.
- `@shared/crypto`: `timingSafeEqual` moved here from `@osn/api`, so both sides
  of a code exchange can compare secrets without one importing the other.
- `@osn/api`: ID tokens for first-party clients now carry an `osn_profile_id`
  claim holding the real `usr_*` profile id, so a first-party app can address a
  person by the same id the ARC routes use instead of the pairwise `sub`. The
  internal profile-organisations route returns full organisation summaries
  (`organisations`) rather than bare `organisationIds` — the public
  `/organisations` projection still has no id, which is why the caller needs
  this one.
- `@osn/social`: the settings page reads and writes the URL fragment, so other
  apps can deep-link to `/settings#security`. Passkeys are bound to this
  origin's RP ID and can only be managed here.
