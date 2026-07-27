# @shared/rp-auth

## 0.1.1

### Patch Changes

- 0c7dc46: Support `prompt=create` — let a relying party open the consent screen on its
  sign-up half.

  "Initiating User Registration via OpenID Connect 1.0". A relying party sends
  `prompt=create` when it knows the visitor has no account yet; the provider then
  leads with registration rather than sign-in, and the new user lands back on the
  app signed in, inside the same OIDC transaction.

  **`@osn/api`.** `prepareAuthorization` checks `create` before every other branch
  — a signed-in visitor who clicked "create an account" meant it — and parks the
  request with the same `requireAuthAfter = now` that `prompt=login` uses, so the
  decision only accepts a session created after the request arrived. Registration
  ends in an enrolled passkey and an adopted session, which satisfies that. The
  pre-existing rule that `none` may not be combined with another value already
  rejects `none`+`create`, so the branch is unreachable in silent mode.

  **`@osn/social`.** `AuthorizeSignIn` now holds both halves of "who are you" and
  swaps between them: a "No account yet? Create one" link under sign-in, and
  Cancel back from registration. It opens on registration when the server says
  `reason=create`. Without that second half a relying party's "Create account"
  button was a dead end — the screen only ever offered a passkey ceremony to
  someone who had no passkey. `reason` is advisory copy; the server re-derives
  every requirement at decision time, so a tampered value widens nothing.

  **`@shared/rp-auth`.** `signInUrl` takes an options bag, and `startCreateAccount`
  is the same journey opened on the sign-up screen. Only `create` is ever passed
  through.

- 0c7dc46: Add `resumeSession` — carry an already-signed-in visitor past the sign-in page.

  A sign-in page that has buttons on it cannot redirect on mount, but it should
  not ask someone for a session they already hold either. `resumeSession` asks
  `GET {basePath}/session` behind the rendered page and, if the answer is yes,
  navigates to `home` with `location.replace`, leaving no history entry for
  `Back` to bounce through. A signed-out visitor waits for nothing: the buttons
  render first, and an unreachable API reads as signed out.

  It deliberately only sees the relying party's own cookie. A session at the
  issuer is unreachable from a background request — that cookie is
  `SameSite=Lax`, so it rides top-level navigations only, and a hidden-iframe
  `prompt=none` probe would report "signed out" in every browser regardless of
  third-party-cookie policy. Asking properly needs a full-page redirect, which is
  the behaviour this replaces.

  It also refuses to ping-pong. An app that bounces its own 401s back to the
  sign-in page could trade redirects with this one if the two disagreed — a
  session expiring between the calls. `resumeSession` stamps `rp-auth.resumed-at`
  in `sessionStorage` and skips the next resume within five seconds, so a loop
  stops after a single lap while a deliberate return visit still gets carried
  through. Signing out clears the stamp. Both the storage and the navigation are
  injectable.

## 0.1.0

### Minor Changes

- 2b7a7f1: Support relying parties that sign people in through the OSN OIDC issuer.

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
