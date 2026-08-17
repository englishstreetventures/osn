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
