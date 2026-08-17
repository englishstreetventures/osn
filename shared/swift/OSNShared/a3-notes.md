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
- No conditional UI / passkey autofill: `PasskeyCeremonyRunner` never calls
  `performAutoFillAssistedRequests()`. The discoverable-credential flow the
  brief asked for works; the QuickType-bar suggestion does not exist yet.
- Xcode build of the Pulse target with the new entitlements has not been
  run — `swift build`/`swift test` only exercise the SPM package, not the
  Xcode project XcodeGen would generate. Nothing blocks that build now (see
  BLOCKED below); it just hasn't been done.

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
