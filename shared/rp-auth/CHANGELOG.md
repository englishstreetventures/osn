# @shared/rp-auth

## 0.2.4

### Patch Changes

- d96da64: Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges.

  `fast-uri` 3.1.5 → 3.1.7. Four high advisories against 3.1.5 landed on 2026-09-02 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — two SSRF, two host confusion) and the pre-push `bun audit` gate went red. Taking 3.1.6, which is what those four advisories name as fixed, would have left two more: 3.1.7 also fixes GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port in `serialize()`) and GHSA-58mr-gqgx-xq4g (host confusion via unbalanced IP-literal brackets), neither of which is in the public advisory database yet, so no audit tool reports them. Reachability is the Astro language server only — `ajv` appears once in the lockfile, under `@astrojs/check`, and no deployed Worker or shipped bundle contains it. `smol-toml` 1.6.1 → 1.8.0 is the same shape: 1.7.1 carries the fix for GHSA-7w5x-hrqm-74c2, also absent from the database.

  The rest is lockfile lag. The dependency sweep in this stack raised every declared range, but `bun.lock` stayed behind versions those ranges already admitted: `esbuild` 0.28.2, `postcss` 8.5.26, `picomatch` 4.0.7, `sharp` 0.35.4 (libvips 1.3.3), `js-yaml` 4.3.2, `ws` 8.21.3, `devalue` 5.9.2, `happy-dom` 20.12.2, `@cloudflare/workers-types` 5.20260903.1. Two are worth knowing about rather than just taking: `ws` 8.21.1 **lowers the `maxBufferedChunks` and `maxFragments` defaults** and counts empty fragments toward the limit, which is a behaviour change inside a patch and touches Zap's WebSocket surface; `picomatch` 4.0.5–4.0.7 are all matching-semantics fixes, so glob-driven config can shift.

  `astro` 7.2.9 → 7.2.10 is the one with deployed consequences. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. It is pinned to 7.2.10 rather than left to float: 7.3.0 and 7.3.1 clear the three-day soak but not the fourteen-day rule for a minor, so they wait.

  Two overrides were correcting themselves in the wrong direction and are fixed here. `undici` was pinned `^7.29.0` while `jsdom` 30 declares `undici ^8.9.0` and `unifont` 0.7.5 declares `^8.0.0` — a floor being used as a ceiling, holding both consumers a whole major below what they were written for and cutting the tree off from undici 8 security fixes. Raised to `^8.9.0` (resolves 8.10.1). Because top-level `miniflare` 4 pins undici at exactly 7.28.0 and the wrangler-nested miniflare 5 alpha pins 7.29.0, this was verified rather than assumed: type check, the full test suite, the Miniflare D1 tier, all four Worker builds, and a real `wrangler dev --local` boot of `osn-api` on workerd, which serves 200 on `/health`, `/.well-known/jwks.json` and `/` with no errors. `postcss` and `picomatch` were likewise below what `vite` 8.2.2 asks for (`^8.5.26` and `^4.0.5`), a floor gap opened by raising vite earlier in this stack.

  Also: the `protobufjs` override matched nothing in the lockfile and is removed, and `bunfig.toml`'s note on the removed `fast-uri` soak exclusion claimed the package "parses URIs on the request path via ajv", which is not true of this tree and would have mispriced exactly the decision this changeset had to make.

  One source change, in `cire/api/tests/index.test.ts`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` a required member of `Span`, so the test's `StubSpan` gains it, typed off the interface rather than restated so the next daily types release cannot drift it.

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

## 0.2.3

### Patch Changes

- 853367f: Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Every package listed here sits on that chain. Build output is byte-identical.

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
