# A3 notes — OSNAuth passkey clients

## Verified

- `swift build`/`swift test` clean on macOS host: full run 32 tests, 7
  suites, 0 failures, no regression to OSNKit/PulseAPI tests. Re-run after
  the contract fixes below, not just before them.
- Wire shapes checked line by line against the routes and services in
  `osn/api/src/routes/auth/` and `osn/api/src/services/auth/`, not against
  the brief's restatement of them. Two defects came out of that gap and are
  fixed on this branch:
  - **Enrollment sent no `Authorization` header.**
    `resolvePasskeyEnrollPrincipal` (`context.ts:231`) wraps
    `resolveAccessTokenPrincipal(auth, authHeader)` and has no cookie
    fallback, so both `/passkey/register/begin` and `/complete` would have
    401'd on every call. Bearer now applied to both. The session cookie's
    only role here is naming the caller's own session so the S-H1 sweep
    spares it (`passkey-enroll.ts:98`) — it is not what authenticates.
  - **`rename` decoded the wrong body.** `PATCH /passkeys/:id` returns a
    bare `{ "success": true }` (`passkey-management.ts:84`), not the updated
    summary, so decoding a `PasskeySummary` threw `.responseMalformed` on
    the *happy* path — after the write had committed. `rename` now returns
    Void and decodes `PasskeyRenameResult`.
- Step-up `purpose` is now the `StepUpPurpose` enum over the server's nine
  literals (`step-up.ts:89-101`) instead of a free `String`, so a typo can't
  reach the wire. `passkeyDelete` covers rename *and* delete: the server
  shares one verifier for the pair (`services/auth/step-up.ts:398-400`);
  there is no `passkey_rename`.
- `transports` is `[String]?` because the server parses it before returning
  (`passkey-management.ts:76`), not a joined string.
- Base64url round-trip tested at both padding lengths (`Base64URLTests`).
- `/login/passkey/complete` body encodes exactly one of
  `identifier`/`challengeId` (`PasskeyCompleteRequestBodyTests`).
- `SingleResumeContinuation` resumes exactly once; a second
  `resume(returning:)`/`resume(throwing:)` is a no-op
  (`SingleResumeContinuationTests`).
- `ASAuthorizationError.canceled` maps to `PasskeyCeremonyError.cancelled`,
  distinct from `.underlying` (`PasskeyCeremonyErrorTests`).
- Successful `PasskeyLoginClient.complete` persists the access token to
  `KeychainAccessTokenStore` with the server's `expires_in`, and the
  rotated `osn_session` cookie is confirmed present in the session's
  cookie storage afterward (`PasskeyLoginClientTests`).
- A complete response missing the rotated cookie throws
  `OSNKitError.sessionCookieNotPersisted` and does not write to Keychain.
- RP ID is read from the server's begin-response payload in
  `PasskeyLoginClient`/`PasskeyEnrollmentClient`/`StepUpPasskeyClient` —
  grepped, no hardcoded `musubi.social` in ceremony code.
- Every OSNAuth request runs through the shared `URLSession` /
  `SharedCookieJar` — no client constructs its own session or cookie
  storage.
- `OSNSession` (new, `OSNAuth`) extracted as the app-agnostic sign-in owner;
  `PulseFeature.PulseSession` now forwards to it (`state` is computed from
  `auth.state`, never a synced stored copy — that would break `@Observable`
  tracking). Covered by `OSNSessionTests`: a failing `TokenRefresher.refresh()`
  during `restore()` lands on `.signedOut`, never `.failed`; `signOut()`
  clears the Keychain access token; `ensureFreshAccessToken()` refreshes
  when the stored token is missing or expires within 30s and is a no-op
  (asserted via request count against `LoginMockURLProtocol`) when the
  token is still fresh.
- New `OSNAuthUI` target (`OSNAuth` + `OSNUI`) holds `PasskeySignInView`,
  the app-name-parameterized, `OSNSession`-driven successor to
  `PulseFeature`'s old `SignInView`. `PulseRootView` renders it against
  `session.auth`; no other view changed.

## Musubi (second client)

- New `MusubiFeature` target (`OSNKit`/`OSNAuth`/`OSNUI`/`OSNAuthUI`, no API
  client — Musubi talks to OSNAuth's clients only). `MusubiRootView` gates
  directly on `OSNSession.state` (no `PulseSession`-style wrapper) and
  reuses `PasskeySignInView` unmodified. `MusubiAccountView` is read-only:
  lists passkeys, shows the profile when `.signedIn` carries one (`nil` on a
  restored session — handled, not force-unwrapped), and a sign-out button.
  No rename/delete UI — both need a step-up ceremony
  (`wiki/systems/step-up.md`), out of scope.
- `ensureFreshAccessToken()` runs immediately before every
  `PasskeyManagementClient.list()` call in `MusubiAccountView`, per
  `RequestHelpers.applyBearerAccessToken`'s no-expiry-check/no-401-retry
  behavior. A load failure surfaces inline in the view (error text + Retry
  button) and never touches `session.state`.
  **Superseded 2026-08-30** (tracker#532, tracker#533):
  `applyBearerAccessToken` is gone, and `AuthenticatedTransport` resolves and
  refreshes the token for every `OSNAuth` client and retries a 401, so the
  call no longer has to come first for the request to authenticate. It stays
  in `MusubiAccountView` as the S-H1 identity check, which is a different
  job.
- `osn/ios/` mirrors `pulse/ios/` (`project.yml`, `Sources/App.swift`):
  bundle id `social.musubi.app`, same team/App-Group/associated-domain
  entitlements. AASA
  (`osn/social/public/.well-known/apple-app-site-association`) now lists
  both `FV59Y8RSUH.social.musubi.pulse` and `FV59Y8RSUH.social.musubi.app`.
  `ci-swift.yml`'s path filter and `swift` job now also generate/build the
  `Musubi` scheme; the job's `name:` string is untouched (may be pinned by a
  required status check).
- **App Group container verified on simulator, 2026-08-17.** Both apps were
  built signed for `iPhone 17 Pro` (iOS 26.3, `C9C6D823-…`), installed, and
  launched. Three things came out of it:
  - The entitlement reaches the bundle. A simulator build is
    `adhoc, linker-signed`, so `codesign -d --entitlements` shows nothing and
    is the wrong probe; the entitlements live in a `__TEXT,__entitlements`
    section and in `<Scheme>.build/<App>.app-Simulated.xcent`. `plutil -p` on
    those prints `com.apple.security.application-groups =>
    ["group.social.musubi.session"]` for both, under
    `FV59Y8RSUH.social.musubi.pulse` and `FV59Y8RSUH.social.musubi.app`.
  - Both apps resolve the **same** container:
    `xcrun simctl get_app_container … group.social.musubi.session` returns
    `…/Containers/Shared/AppGroup/DBBDABDC-4232-4719-BAB3-A65F87FF9FA7` for
    each bundle id.
  - `SharedCookieJar.makeSession()` does not throw in either app. Both
    render `PasskeySignInView`; neither shows `MusubiApp`/`PulseApp`'s
    `Text(sessionError)` fallback, which is the only thing an
    `OSNKitError.appGroupContainerUnavailable` would produce. A live process
    alone proves nothing here — the throw is caught, not fatal — so this was
    checked by screenshot, not by exit status.
- What that check does **not** close: signing in on Pulse and confirming
  Musubi restores signed-in through the shared jar. That needs a real passkey
  ceremony, which is blocked — see §Not verified.

## Not verified

- No device/simulator run of an actual passkey ceremony (`ASAuthorizationController`
  end to end) — only unit-level coverage of the surrounding plumbing
  (encoding, continuation, error mapping, token persistence). The
  ceremony call itself is exercised by test doubles, not a real
  authenticator.
- No confirmation against a live `osn-api` deployment. The shapes are now
  read off the server source rather than the brief (see Verified), but
  nothing has been checked against a captured production payload.
- Conditional UI / passkey autofill (brief T3): `OSNSession.startAutoFillSignIn`
  arms `performAutoFillAssistedRequests()` via a new `PasskeyCeremonyHandle`
  (cancellable, `#if os(iOS)`-gated), and `PasskeySignInView` starts/cancels it
  in `.task`/`.onDisappear`. The three `PasskeyLoginClient` helpers it reuses —
  `beginLogin`, `makeAssertionRequest`, `loginTarget` — are machine-tested
  (`PasskeyLoginClientHelpersTests`), as is `SingleResumeContinuation`'s
  behaviour under a cancel/completion race. What is **not** machine-tested,
  anywhere: `packageAssertion(_:)` (needs an `ASAuthorizationPlatformPublicKeyCredentialAssertion`,
  which Apple vends only from a real ceremony and exposes no public
  initializer for), and the full autofill runtime path end to end
  (`performAutoFillAssistedRequests()` itself, the QuickType suggestion
  appearing, the one-shot silent re-arm on a 120s-TTL-expired challenge, the
  modal/autofill collision handling in `signIn`). CI never executes any of
  that — see the note below. It ships human-reviewed only. That includes the
  cancellation invariant two independent reviews landed on: at most one live
  `ASAuthorizationController` request, always reachable from
  `cancelAutoFillSignIn()`. It is held by three things — cancel-before-arm in
  `attemptAutoFillSignIn`, an identity-checked `clearAutoFillHandle` so an
  overlapping attempt cannot drop a newer handle, and `autoFillReArmTask`
  making the re-arm `signIn` spawns cancellable before it reaches the arm.
  Reading is the only check any of that gets today.
- CI coverage gap, stated plainly: the macOS host runs `swift test`, which
  compiles and runs every `#if os(iOS)` block's *non*-iOS-only siblings but
  cannot execute iOS-only code (`performAutoFillAssistedRequests()` doesn't
  exist on macOS) or drive a real `ASAuthorizationController` ceremony either
  way. The iOS lane runs `xcodebuild ... build`, not `test` — a typecheck, not
  a run. So no line of the autofill path executes in CI on either platform.
  A simulator test lane that could exercise it is a separate task, not
  started here.
- The Xcode build of the Pulse target with the new entitlements has now been
  run (`xcodegen generate` + `xcodebuild -scheme Pulse` against a concrete
  iOS Simulator destination, signed, exit 0), and the resulting bundle
  carries `com.apple.security.application-groups =>
  ["group.social.musubi.session"]` under `FV59Y8RSUH.social.musubi.pulse`.
  Probe it with `plutil -p <DerivedData>/Build/Intermediates.noindex/Pulse.build/Debug-iphonesimulator/Pulse.build/Pulse.app-Simulated.xcent`
  — a simulator build is `adhoc, linker-signed`, so `codesign -d
  --entitlements` prints nothing and proves nothing.
  What that build does **not** cover: it typechecks the `#if os(iOS)`
  autofill code that `swift build` compiles out, but it still never *runs*
  it. See the CI coverage gap above — that stands.

## BLOCKED

Nothing. Cleared 2026-08-15: App ID `social.musubi.pulse` is registered
under team FV59Y8RSUH with both capabilities the entitlements block
declares — **Associated Domains**, and **App Groups** with
`group.social.musubi.session` assigned. So Xcode codesigning of the Pulse
target no longer fails on a missing capability, and
`SharedCookieJar.makeSession()` no longer throws on a correctly signed
build.

The portal never takes the domain string itself. `webcredentials:musubi.social`
is matched against `osn/social/public/.well-known/apple-app-site-association`,
which now names `FV59Y8RSUH.social.musubi.pulse`. iOS reads that file through
Apple's CDN and caches it up to ~24h; during development append
`?mode=developer` to the entitlement and turn on Settings → Developer →
Associated Domains Development to skip the cache. Strip it before TestFlight.

## S-H1 — cached `PasskeyProfile` outliving the Keychain token it was read from (2026-08-17)

Pulse and Musubi share one cookie jar (App Group `group.social.musubi.session`)
and one Keychain access-token slot, but each holds its own `OSNSession` with
its own cached `PasskeyProfile`. Sign into Musubi as A, switch Pulse to B,
come back to Musubi: the cached profile still named A while `loadPasskeys()`
— which authenticates with the now-refreshed, now-B token — listed B's
passkeys, and "Sign out" would have ended B's session under A's label. The
token was always the truth; the cached profile was the only thing that could
lie.

- `AccessTokenClaims` (`Sources/OSNAuth/AccessTokenClaims.swift`) decodes the
  four claims `issueAccessToken` (`osn/api/src/services/auth/tokens.ts`)
  actually mints that this package cares about — `sub`, `email`, `handle`,
  `displayName?` — off whatever JWT is in the Keychain right now, via
  `Base64URL.decode(_:)`. It does not verify the signature and says so in its
  own doc: it exists only to notice *whose* token this is, not to authorize
  anything. A forged token still gets rejected server-side on the next call
  that needs one.
- `reconciledProfile(cached:claims:)` (file-scope in `OSNSession.swift`, not
  a method — it has to be callable as a bare identifier from tests, and a
  function declared inside a Swift class body isn't reachable that way even
  under `@testable import`) is the pure decision: no claims → `nil` (fail
  closed, never guess an identity); `cached.id == claims.sub` → keep `cached`
  verbatim, which is the only way `avatarUrl` survives (claims can't supply
  it); otherwise → a fresh `PasskeyProfile` from the claims with
  `avatarUrl: nil`, because the token now names someone the cache doesn't
  already know.
- `OSNSession.reconcileIdentity()` is `private`, runs only when `state` is
  already `.signedIn`, loads the Keychain token, and calls the above.
  `restore()` calls it right after a successful silent refresh; the public
  `ensureFreshAccessToken()` — the seam every authenticated call already goes
  through — calls it on **both** the already-fresh and the just-refreshed
  path, so a sibling app rotating the shared slot to a different user is
  caught on this app's very next authenticated call, not just at the next
  launch. `revalidate()` is the new public foreground entry point:
  no-op outside `.signedIn`; on `OSNKitError.refreshSessionInvalid` the
  shared session really is dead, so it drops to `.signedOut`; on any other
  error (network hiccup, malformed response) it leaves the sign-in state
  alone but still reconciles against whatever token is already sitting in
  the Keychain, so a failed refresh attempt can never let a wrong name linger
  on screen. `PulseSession.revalidate()` forwards to it. `MusubiRootView` and
  `PulseRootView` both call it from `.onChange(of: scenePhase)` on
  `.active`.
- The `restore()` doc comment now explains why `.signedIn(nil)` is a real
  (if transient) state rather than a bug: a silent restore only round-trips
  `TokenRefresher.refresh()`, which returns a `TokenGrant`, never a profile,
  and no OSNAuth endpoint exposes "fetch current profile". `reconcileIdentity()`
  fills the profile in immediately afterward from the token's own claims —
  the gap between the two calls is not externally observable.
- Tests: `AccessTokenClaimsTests` (8 cases — valid decode, missing optional
  claim, unknown-claims-ignored, 2-segment string, non-base64url segment,
  base64url-but-not-JSON segment, JSON missing `sub`, empty string — all nil
  or fully decoded, nothing in between). `ReconciledProfileTests` (4 cases,
  one per branch of the pure function). `OSNSessionTests` gained two
  end-to-end cases driven entirely through the public API (`state` is
  `private(set)`, so even `@testable import` can't set it directly):
  `ensureFreshAccessTokenReflectsKeychainTokenSwapToADifferentUser` signs in
  as A via `restore()`, swaps the Keychain token to a B JWT directly (no
  `signIn`/`signOut`/`restore` call), then asserts `ensureFreshAccessToken()`
  alone flips the visible profile to B. The sibling case,
  `ensureFreshAccessTokenDropsToNilProfileWhenKeychainTokenIsNotAJWT`, swaps
  in a non-JWT string and asserts the state drops to `.signedIn(nil)` rather
  than keep showing A.
- Not exercised anywhere in this branch: the real two-app ceremony — Pulse
  and Musubi actually installed side by side, sharing the real App Group
  Keychain slot, one switching users while the other is foregrounded. Every
  test above drives the same code path through a mocked `URLSession` and a
  directly-written Keychain entry, which is the honest ceiling of what
  `swift test` on a single package can do; nothing here has been checked
  against two real app processes touching one physical Keychain.
- Deliberately out of scope, left for their own findings: `kSecAttrAccessGroup`
  itself (S-M1 — whether the Keychain entry is even scoped to the shared
  App Group correctly is a separate question from what this app does with
  whatever it reads), per-app request attribution (S-L1), the 30s-skew
  literal and 401-retry behaviour (P-W2), the hard-coded `Environment.local`
  in the test helpers above, and moving the mock `URLProtocol` into
  `OSNTesting`. Of those, the mock has since moved to `OSNTesting`, and the
  skew literal plus the missing 401 retry were filed as tracker#533 with the
  duplicate Keychain read (P-W1) as tracker#532 and closed together on
  2026-08-30 by `AccessTokenProvider` and `AuthenticatedTransport`.
