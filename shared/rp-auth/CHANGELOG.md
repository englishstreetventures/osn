# @shared/rp-auth

## 0.2.2

### Patch Changes

- 70ac0f3: Drop the unused `@testing-library/jest-dom` devDependency from every package that declared it but imports no matcher, now that `vite-plugin-solid` no longer injects its setup file. Guard the suppression markers in CI, and list the marker file under turbo's `globalDependencies` so an edit to it can no longer be served from cache.

## 0.2.1

### Patch Changes

- b219759: Dependency review: drop unused `better-sqlite3`, align stale peer ranges, bump oxfmt

  - `@shared/db-utils` no longer declares `better-sqlite3` or `@types/better-sqlite3`.
    Neither was imported by `src/` or `tests/` — the package has no drizzle-kit and no
    `db:*` scripts, so nothing there ever loaded the native module. The three `*/db`
    workspaces that do run drizzle-kit against a local SQLite file — `osn/db`,
    `pulse/db`, `zap/db` — keep theirs.
  - `@shared/osn-auth-client` peer `elysia` `^1.4.28` → `^1.4.29`, matching the range
    every other workspace declares.
  - `@shared/rp-auth` peer `solid-js` `^1.9.13` → `^1.9.14`, likewise. Both peers already
    resolved to the same version; this only stops the ranges drifting further apart.
  - Root `oxfmt` `^0.59.0` → `^0.62.0`. 0.62.0 changes how a type-annotated arrow return
    is wrapped, which reformats one file in `@pulse/api`
    (`src/services/events.ts`) — whitespace only, no behaviour change.
  - `fast-uri` dropped from `minimumReleaseAgeExcludes` in `bunfig.toml`. It was added
    for the GHSA-v2hh-gcrm-f6hx fix in 3.1.4, which shipped inside the 3-day install
    gate. The override now pins `^3.1.5` and 3.1.5 shipped 2026-07-31, so the entry
    had stopped protecting anything and was exempting every future 3.x publish.

## 0.2.0

### Minor Changes

- 30b4e72: Sign Pulse web in through the OSN OIDC redirect flow, with the browser holding a Pulse session cookie instead of an access token.

  The WebAuthn RP ID is `musubi.social`, so a Pulse origin can no longer run a passkey ceremony. Pulse web now sends people to the OSN authorize endpoint and the Pulse API completes the code exchange, then sets its own host-scoped HttpOnly session cookie. The browser never sees an OSN token.

  - `useAuth()` comes from `@shared/rp-auth/solid` and returns `{ session, activeProfileId, authFetch, signIn, logout, refresh }`. `RpSession` carries identity fields only — no `accessToken`.
  - Every `pulse/web/src/lib` call drops its token argument; the cookie authorises the request. Resources that keyed on the token now key on the viewer's profile id.
  - Close friends: the browser can't read the OSN graph, so Pulse serves the candidate list. `listCloseFriendCandidates()` returns `null` when the graph is unreachable, which the page reports as a failure rather than an empty list.
  - Settings drops the handle-setup card. Name, handle and email belong to the musubi account and are edited there.
  - `AuthErrorToast` surfaces a failed or declined sign-in from the `?auth_error=` marker the callback leaves behind.
  - Removes `src/lib/authClients.ts` and the `@simplewebauthn/browser` dependency from the web app.
  - `createClient` in `@pulse/api` takes an optional Eden treaty config, so a browser caller can set `credentials: "include"`.

  Deploy note: the Pulse API must be same-site with the web origin (`api.<pulse-domain>`), or the `SameSite=Lax` session cookie is never sent.

## 0.1.2

### Patch Changes

- 8226487: Refresh dependencies across the monorepo (routine maintenance audit).

  Security-relevant: `@simplewebauthn/server` 13.3.0 → 13.3.2 closes
  GHSA-6hxq-p678-4hr2 (CVSS v4 Low 2.0), where a maliciously-crafted attestation
  `x5c` could present a self-signed "root certificate" rather than chaining to an
  RP-specified trust anchor. Reached through `verifyRegistrationResponse()` on the
  passkey registration path. Exposure was nil rather than merely limited: we
  configure no trust anchors anywhere, so `validateCertificatePath` short-circuits
  on `trustAnchorsPEM.length === 0` and no chain decision was ever made — in
  13.3.0 as much as in 13.3.2. Tracked as S-L102, which also records why
  `attestationType: "none"` is _not_ the control here.

  `jose` moves 6.2.3 → 6.2.4 only, which is a docs update plus an `exportJWK`
  refactor that drops `undefined`-valued properties. That change is inert for us:
  `exportKeyToJwk` immediately `JSON.stringify`s its result, and `thumbprintKid`
  feeds RFC 7638 canonicalisation over `kty`/`crv`/`x`/`y`, so existing `kid`s and
  stored JWKs are byte-identical. The JOSE input-validation hardening (Base64URL
  alphabet, UTF-8 in headers and claims, truncated ASN.1 key data, duplicate
  `crit`) is in **6.2.5**, which this branch does _not_ take — it published
  2026-07-29 and is inside the 3-day quarantine. That upgrade is tracked
  separately and matters, since `jose` sits under both ARC S2S tokens and the
  5-minute `osn-access` JWTs.

  `effect` 3.21.2 → 3.22.0 (deprecates `Graph.neighborsDirected`, unused here),
  with `@effect/vitest` 0.29 → 0.30 and `@effect/opentelemetry` 0.63 → 0.64
  following its `^3.22.0` peer. `@effect/platform` is now an explicit
  `@shared/observability` dependency at `^0.97.0`: it was previously auto-installed
  at 0.94.5 purely to satisfy `@effect/opentelemetry`'s peer and did not actually
  meet it.

  `oxlint` 1.70 → 1.76 makes `vitest/expect-expect` effective inside `it.effect`
  bodies for the first time — the rule was already configured with
  `additionalTestBlockFunctions`, but earlier versions never walked those blocks.
  Ten `@osn/api` tests (of 644) were relying on "the Effect didn't fail" as their
  only assertion; each now asserts the behaviour its name claims, with no change
  to what is under test.

  The `@opentelemetry/*` SDK packages are held at `~2.9.0` rather than moved to
  2.10.0. The exporters and `sdk-logs` cannot follow yet — 0.221.0 is inside the
  14-day minor window — and the 0.220.0 exporters pin `core`/`resources`/
  `sdk-metrics`/`sdk-trace` to exactly 2.9.0, so taking only the SDK half splits
  the tree across two lines and links 2.10.0 packages against `core@2.9.0`. The
  tilde is deliberate: `^2.9.0` still admits 2.10.0. The whole line moves together
  once the exporters are eligible (2026-08-04).

  The root `esbuild` override rises `^0.27.0` → `^0.28.1`, closing
  GHSA-g7r4-m6w7-qqqr. The override had inverted from protective to harmful:
  wrangler 4.114 pins `esbuild 0.28.1` — the fixed version — and the `^0.27.0`
  floor was clamping the whole tree back down to the vulnerable 0.27.7. astro
  already declares `^0.28.0`, so `^0.28.1` now agrees with both consumers instead
  of fighting either. `bun audit` reports no vulnerabilities.

  `oxfmt` 0.44 → 0.59 spans four breaking formatter changes, but produces no
  output change here: the `fmt` script already excludes CSS, astro and markdown,
  and the `sort_imports` reclassification of subpath imports matches nothing in
  the tree. `bun run fmt` is a no-op on the current sources and `fmt:check` is
  clean. 0.60/0.61 stay out until they clear the 14-day minor window.

  Everything else is a patch/minor bugfix bump with no migration steps.

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
