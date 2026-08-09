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
  run (would fail regardless — see BLOCKED below) — `swift build`/`swift test`
  only exercise the SPM package, not the Xcode project XcodeGen would
  generate.

## BLOCKED

- `pulse/ios/project.yml`: `com.apple.developer.associated-domains`
  (`webcredentials:musubi.social`) and App Group
  `group.social.musubi.session` are declared in the entitlements block
  but neither capability is registered in the Apple developer portal.
  Xcode codesigning of the Pulse target will fail until both are added
  there.
