---
title: Passkey-Primary Login (M-PK)
tags: [auth, passkey, webauthn, security-key, login]
related:
  - "[[identity-model]]"
  - "[[sessions]]"
  - "[[recovery-codes]]"
  - "[[step-up]]"
packages:
  - "@osn/api"
  - "@osn/client"
  - "@osn/ui"
last-reviewed: 2026-04-23
---

# Passkey-Primary Login

OSN accepts exactly one primary login factor: a WebAuthn credential — either a
platform passkey (Face ID / Touch ID / Windows Hello / Android screen lock)
or a roaming security key (FIDO2 Yubikey etc.). OTP and magic-link primary
login have been removed; OTP survives as the step-up and email-change
verification factor.

## Account-level invariant

**Every live account has ≥1 WebAuthn credential at all times.** The invariant
holds cradle-to-grave:

- **Registration.** `/register/complete` returns a session, but the UI
  refuses to dismiss the registration flow until `/passkey/register/complete`
  succeeds. There is no "skip for now" button.
- **Deletion.** `deletePasskey` refuses unconditionally if the delete would
  drop the account below 1 passkey (`osn/api/src/services/auth.ts`). Recovery
  codes are NOT a substitute credential — they are the "my device is gone"
  escape hatch only.
- **Rotation.** Users who want to remove a compromised passkey enroll the
  replacement first, then delete the old one. No transitional states.

## Login surface

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /login/passkey/begin` | — | Issue WebAuthn options. Identifier-bound or identifier-less (discoverable). |
| `POST /login/passkey/complete` | — | Verify the assertion and issue a session. |
| `POST /login/recovery/complete` | — | Exchange identifier + recovery code for a session. Escape hatch. |

Client SDK surface (`@osn/client`):

- `LoginClient.passkeyBegin` / `passkeyComplete` — the only primary methods.
- `RecoveryClient.loginWithRecoveryCode` — the escape hatch.

UI surface (`@osn/ui/auth`):

- `<SignIn>` — WebAuthn-only. Renders a "Lost your passkey?" link that routes
  to `<RecoveryLoginForm>`. Feature-detects `browserSupportsWebAuthn()`; when
  false, shows a "passkey or security key required" screen that still lets
  the user enter a recovery code.
- `<Register>` — WebAuthn-gated. Registration is blocked at the start if the
  environment lacks WebAuthn support; completion is blocked until first-
  credential enrollment succeeds.

## Accepting security keys

`generateRegistrationOptions` uses `residentKey: "preferred"` +
`userVerification: "required"`:

- Modern platform passkeys register as discoverable credentials with UV
  (the Copenhagen Book path).
- FIDO2 security keys with PIN/biometric register as non-discoverable — they
  work for identified login but not for the identifier-less flow.
- Obsolete UP-only U2F tokens **cannot register** — intentional (S-H2). They
  would fail at verification time anyway because `verifyAuthenticationResponse`
  sets `requireUserVerification: true`; admitting them at registration and
  rejecting at login would only produce broken accounts.

Both login options (identified and identifier-less) use `userVerification:
"required"` so options and verifier agree. The ceremony is phishing-resistant
with a second factor (UV = PIN, biometric, or device unlock).

## Step-up gating on register (S-H1)

`/passkey/register/begin` requires a fresh step-up token (`X-Step-Up-Token`
header or `step_up_token` body field; webauthn or otp AMR) when the account
already has ≥1 passkey. First-passkey enrollment (bootstrap) bypasses the
gate because no step-up ceremony is reachable before the account has any
credentials. This closes the "stolen access token → silent authenticator
binding" vector that the enrollmentToken deletion otherwise opened.

`/passkey/register/complete` additionally:
- Inserts a `security_events{kind: "passkey_register"}` row in the same
  transaction as the passkey insert — the user sees the new-credential
  banner even if an attacker skips the email client.
- Fires a best-effort `notifyPasskeyRegisteredByAccountId` via `forkDaemon`
  with a 10-second timeout. The body never includes identifying material.
- Derives the caller's session token from the HttpOnly cookie — H1
  invalidation of every other session cannot be silently skipped by a
  malicious caller omitting a body field.

## WebAuthn-unsupported environments

`browserSupportsWebAuthn()` is checked on mount in both `SignIn.tsx` and
`Register.tsx`. When false:

- **Register** — shows an informational screen, blocks the flow.
  Registration on a WebAuthn-incapable device would produce an account with
  no credentials and is never allowed.
- **SignIn** — shows an informational screen with these escape paths:
  - Sign in on a WebAuthn-capable device.
  - Use the password-manager cross-device / QR (CaBLE / hybrid) flow.
  - Plug in a FIDO2 security key and reload.
  - Use a recovery code.

## Recovery flow

Unchanged contract: `POST /login/recovery/complete` returns a session
directly. The user can immediately add a new passkey from the authenticated
state. This is the one place the account-level invariant sees a "temporary"
relaxation: a recovery-login session whose user deleted their old passkey
on a different device before the recovery would technically have access
via only recovery codes — but because `deletePasskey` itself refuses to
leave 0, that state is unreachable in normal operation.

## Enumeration safety (S-M1)

`/login/passkey/begin` returns a uniform `200 { options: { allowCredentials,
userVerification, … } }` in all three branches:

- Unknown identifier: synthetic `allowCredentials` of length 1 (random 32
  bytes, base64url). No challenge is persisted, so a subsequent
  `/login/passkey/complete` hits the "challenge not found" guard,
  indistinguishable from a legitimate timeout.
- Known account with 0 passkeys (unreachable in practice — the ≥1 invariant
  holds — legacy/corrupt data only): same synthetic shape.
- Known account with ≥1 passkey: real `allowCredentials` from the DB.

An anonymous caller cannot probe the handle/email namespace through this
endpoint. A DB SELECT runs on both branches (real query for known; a
never-matching accountId query for unknown) so the latency distribution is
the same.

## Access-token audience (S-M2)

Access tokens carry `aud: "osn-access"`; `verifyAccessToken` asserts it.
This prevents any future token type minted with the same ES256 key from
authenticating access-token routes by accident.

## What was removed

- **Routes**: `POST /login/otp/{begin,complete}`, `POST /login/magic/{begin,verify}`.
- **Service methods**: `beginOtp`, `completeOtpDirect`, `beginMagic`,
  `verifyMagicDirect`, `issueEnrollmentToken`, `verifyEnrollmentToken`.
- **In-memory state**: `otpStore`, `magicStore`, `consumedEnrollmentTokens`.
- **Config fields**: `magicLinkBaseUrl`, `magicTtl`.
- **Client SDK methods**: `LoginClient.otpBegin/otpComplete/magicBegin/magicVerify`;
  `CompleteRegistrationResult.enrollmentToken`; `passkeyRegisterBegin/Complete`
  now take `accessToken` instead of `enrollmentToken`.
- **UI components**: `@osn/ui/auth/MagicLinkHandler` (deleted).
- **Rate-limiter slots**: `otpBegin`, `otpComplete`, `magicBegin`.
- **Metrics**: `osn.auth.magic_link.sent`; `AuthMethod` union narrowed to
  `"passkey" | "recovery_code" | "refresh"`; `AuthRateLimitedEndpoint`
  dropped `otp_begin`, `otp_complete`, `magic_begin`.
- **Body input**: `POST /passkey/register/complete` no longer accepts
  `session_token` in the body; the server derives it from the HttpOnly
  cookie (S-H1).
