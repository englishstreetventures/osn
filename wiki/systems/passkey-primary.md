---
title: Passkey-Primary Login (M-PK)
tags: [auth, passkey, webauthn, security-key, login]
related:
  - "[[identity-model]]"
  - "[[sessions]]"
  - "[[recovery-codes]]"
  - "[[step-up]]"
  - "[[dev-environment]]"
packages:
  - "@osn/api"
  - "@osn/client"
  - "@osn/ui"
  - "@musubi/social"
last-reviewed: 2026-09-10
---

# Passkey-Primary Login

OSN accepts exactly one primary login factor: a WebAuthn credential — either a
platform passkey (Face ID / Touch ID / Windows Hello / Android screen lock)
or a roaming security key (FIDO2 Yubikey etc.). We removed OTP and magic-link
primary login; OTP survives as the step-up and email-change verification
factor.

## Account-level invariant

**Every live account has ≥1 WebAuthn credential at all times.** The invariant
holds from registration to deletion:

- **Registration.** `/register/complete` returns a session, but the UI
  refuses to dismiss the registration flow until `/passkey/register/complete`
  succeeds. There is no "skip for now" button. **`Register.tsx` holds that
  session without adopting it** — enrolment authenticates with the returned
  access token, passed explicitly as a bearer token, so nothing before the
  ceremony needs a published session. It adopts only once the credential
  exists. Adopting earlier announces a signed-in user whose account has zero
  passkeys, and consumers act on that announcement: `@musubi/social`'s
  `AuthDialogs` hides its auth dialogs the moment `session()` is truthy,
  which unmounted the flow mid-registration and skipped enrolment entirely
  (fixed 2026-08-15). Anything that publishes a session before the first
  credential breaks this invariant, whatever the UI claims.
  **Known hole:** `/register/complete` sets the refresh cookie, so a user who
  abandons at the passkey step and reloads is signed in to a passkey-less
  account and never re-prompted. Reloading is not the only way there — Cancel
  is live on the passkey step, the shell unmounts when the viewport crosses the
  `md` breakpoint, and the enrolment access token dies after 5 minutes with no
  refresh path. That session also satisfies `/authorize`, so a credential-less
  account can be federated to a relying party. Closing the hole properly needs a
  server-side registration-incomplete state that gates `/authorize` and `/token`
  as well as app routes; a client-side `logout()` on the walk-away paths is a
  worthwhile partial, since `POST /logout` needs only the cookie. See
  `xchromo/osn-tracker` for all three findings.
- **Deletion.** `deletePasskey` refuses unconditionally if the delete would
  drop the account below 1 passkey (`osn/api/src/services/auth/passkey-management.ts`). Recovery
  codes are NOT a substitute credential — they are the "my device is gone"
  escape hatch only.
- **Rotation.** Users who want to remove a compromised passkey enrol the
  replacement first via Settings → Security → "Add passkey", then delete
  the old one. The add-passkey flow is step-up gated (passkey or OTP AMR)
  so a stolen access token can't silently bind a new authenticator — see
  "Step-up gating on register" below.

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
- `<RecoveryLoginForm>` — the factor chooser behind that link: a recovery code,
  an emailed code, or an authenticator code. Only the first mints an ordinary
  session; see [[#What the recovery screen does with a restricted session]].
- `<Register>` — WebAuthn-gated. The flow stops at the start if the
  environment lacks WebAuthn support, and completion stays blocked until
  first-credential enrolment succeeds.
- `<PasskeysView>` (`@osn/ui/auth/PasskeysView`) — Settings → Security
  surface. Lists the account's credentials; supports rename (step-up
  gated, S-M2), delete (last-passkey guarded), and **Add passkey** (step-up
  gated via the same `/passkey/register/*` endpoints the registration
  flow uses). `@musubi/social` mounts it behind a lazy-loaded
  `SecuritySection` so `@simplewebauthn/browser` only ships when the tab
  is opened. It also renders a collapsible **"Signing in somewhere new?"**
  help disclosure that points users at the three real ways onto a fresh
  device (backed-up/synced passkey, password-manager cross-device QR,
  recovery code) — see "New-device onboarding" below.
  - **`passkeyOnly` prop** — see [[#What `passkeyOnly` means]] below.

### Surfaces that mount `<PasskeysView>`

| App | Mount point | Notes |
|---|---|---|
| `@musubi/social` | lazy `SecuritySection` (Settings → Security) | All three step-up factors available. Also mounts `<TotpView>` and `<RecoveryCodesView>`, and hands each a `TotpClient`. |
| `@cire/host` | **none** | `SecurityPanel.tsx` used to render it. It no longer does: a WebAuthn credential only works on an origin same-site with its RP ID, and passkeys are bound to `musubi.social`, so `host.cireweddings.com` cannot run the ceremony — and under the OIDC flow the portal never holds an OSN access token to authenticate a passkey call with. The panel links out to `${OSN_ACCOUNT_URL}/settings#security` instead. |

> [!info] `passkeyOnly` has no callers
> With the cire mount gone, nothing in this repository sets it. It stays on the
> component because `@osn/ui` is OSN-the-system rather than Musubi's own code
> ([[osn-and-musubi]]) and any instance running without deliverable mail needs
> it. That is also why the decision below settles its *meaning* rather than
> deleting it.

### What `passkeyOnly` means

**It means the host cannot deliver mail.** It suppresses the emailed-code
factor and nothing else: the passkey factor is unaffected, and the
authenticator-app factor stays on offer wherever the ceremony and the account
allow it. With it set the dialog also auto-starts the passkey ceremony on
mount, since there is no factor picker to show first.

The reason is the whole reason the prop exists. It is there so an OTP step-up
cannot dead-end on a code that never arrives — and a TOTP code has no delivery
step, so it cannot fail that way. Suppressing it too would remove a working
factor for no benefit, on exactly the hosts with fewest factors left.

> [!note] Why it was not renamed to something like `noEmailFactor`
> That name is more accurate and the rename was considered. Against it: the
> prop has no callers, so a breaking change across a package three workspaces
> consume would benefit nobody; and where no authenticator is enrolled — every
> account until the TOTP surfaces shipped — the dialog really is passkey-only,
> which is the state the name was written for. The ambiguity is closed by
> writing the meaning down here and in the prop's own TSDoc rather than by
> moving it. Do not re-litigate without a caller to point at.

### Which factors a ceremony offers

`<StepUpDialog>` derives this from its `purpose` rather than offering every
factor everywhere, because a factor the gated endpoint refuses is not a shorter
menu — it is a dead end. The ceremony succeeds, a token is minted, and the call
it was minted for fails.

| Ceremony | Passkey | Emailed code | Authenticator |
|---|---|---|---|
| `passkey_register`, `totp_enroll`, `totp_disable` | yes | yes | yes |
| `recovery_generate`, `security_event_ack`, `account_delete`, `account_export`, `pulse_app_delete`, `zap_app_delete` | yes | yes | yes |
| `passkey_delete` (gates rename too) | yes | **no** | **no** |
| `email_change` | yes | yes | **no** |

That table mirrors the **defaults** in `osn/api/src/services/auth/context.ts`;
three of the four allow-lists are `AuthConfig` fields, so a deployment that
narrows one reintroduces a dead end the UI cannot see. No deployment sets them.

Fixing this removed a dead end that had been live: the dialog previously
offered "Email me a code" for passkey rename and delete, whose gate is
`["webauthn"]`, so the code arrived and the action still failed. The
authenticator factor additionally requires a confirmed credential — the dialog
asks `GET /totp/status` itself rather than taking a flag from its host, so the
two cannot be wired inconsistently.

## New-device onboarding

Getting onto a brand-new device that holds no passkey yet does **not** use a
custom OSN flow — it reuses what already exists, surfaced as UI copy in the
`<PasskeysView>` help disclosure and the WebAuthn-unsupported `<SignIn>`
screen:

1. **Backed-up / synced passkey** — platform passkeys saved to iCloud
   Keychain, Google Password Manager, or a third-party password manager are
   already present on the user's other signed-in devices. No transfer needed.
2. **Cross-device sign-in (CaBLE / hybrid)** — on the sign-in screen the user
   picks the QR / nearby-device option their password manager offers and
   approves it from their phone. The osn-api cross-device endpoints
   (`/login/cross-device/*`, see `[[sessions]]`) exist for a future
   first-party QR transfer, but the password-manager hybrid flow covers the
   common case today with no extra client code.
3. **Recovery code** — if every passkey is lost, the user signs in via the
   "Lost your passkey?" recovery-code path, then enrols a fresh passkey from
   the authenticated Security panel.

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
already has ≥1 passkey. First-passkey enrolment (bootstrap) bypasses the
gate because no step-up ceremony is reachable before the account has any
credentials. This closes the "stolen access token → silent authenticator
binding" vector that the enrollmentToken deletion otherwise opened.

`/passkey/register/complete` additionally:
- Inserts a `security_events{kind: "passkey_register"}` row in the same
  transaction as the passkey insert — the user sees the new-credential
  banner even if an attacker skips the email client.
- Fires a best-effort `notifyPasskeyRegisteredByAccountId` via `forkBackground`
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

Three paths, and only the first mints an ordinary session.

`POST /login/recovery/complete` is unchanged: a recovery code returns a session
directly, and the user can immediately add a new passkey from the authenticated
state. This is the one place the account-level invariant sees a "temporary"
relaxation. A user who deleted their old passkey on another device before
the recovery would technically hold an account backed by recovery codes
alone. Because `deletePasskey` refuses
to leave 0 passkeys, that state is unreachable in normal operation.

`POST /login/recovery/email/complete` and `POST /login/recovery/totp/complete`
mint a **restricted** recovery session instead.
See [[recovery-codes#The three ways back in]] and [[account-recovery-factors]] §B.

### What the recovery screen does with a restricted session

`<RecoveryLoginForm>` opens on a factor chooser. The recovery-code path is
unchanged — it mints an ordinary session, adopts it, and hands off. The two new
paths behave differently in four ways, each forced by the restriction:

- **They are hidden where `browserSupportsWebAuthn()` is false.** A restricted
  session's one permitted action is a WebAuthn ceremony, so on a browser that
  cannot run one it can do nothing at all; offering the path would mint a
  credential the user cannot use and strand them when it expires. The screen
  shows the same escape routes as the unsupported-browser sign-in screen
  instead. The same rule hides them when the host wired no registration client
  or ceremony runner: a path is offered only when everything needed to finish
  it is present.
- **They route straight into passkey enrolment**, with one action and copy that
  says what a recovery session is and what it can do. No menu, nothing else on
  offer.
- **They never adopt the session — before or after enrolment.** Adopting early
  unmounts the flow (`AuthDialogs` hides its dialogs the moment `session()` is
  truthy, the trap recorded above for registration). Adopting *late* is equally
  wrong, and this is where the `<Register>` analogy stops: `<Register>` holds an
  `osn-access` token, whereas these hold `osn-recovery`, and
  `POST /passkey/register/complete` returns no new token set — it clears
  `restrictedUntil` on the row but cannot rewrite a JWT already in the browser.
  Publishing it would announce a signed-in user whose token every ordinary route
  rejects, and `listProfiles` uses a plain `fetch` with no silent refresh to
  repair it. So a successful recovery ends by sending the user back to sign in
  with the passkey they now hold — which also proves the new credential works
  while they can still recover again if it does not.
- **Expiry is its own screen**, not a 401 toast. Somebody who has just proved
  who they are and then meets a generic error concludes the product is broken.

> [!warning] The screen gets five minutes, not fifteen
> Two deadlines are in play and the shorter one is the one the browser sees.
> The session row lives `RECOVERY_SESSION_TTL_SEC` (900 s), but the access
> token in the same response is signed with `accessTokenTtl` — 300 s by default
> — and this flow holds the token outside `AuthProvider`, so `authFetch`'s
> silent refresh is unavailable and `@osn/client` exposes no standalone
> `/token` grant to call instead. The screen therefore arms its timeout on the
> session's own `expiresAt` and never claims fifteen minutes. Widening it back
> out is `xchromo/osn#976`.

> [!important] An emailed code that yields a session is not the OTP login this page removed
> The resemblance is real and worth stating plainly, because "we deleted OTP
> login" and "we added an emailed six-digit code that signs you in" sound like a
> contradiction. What separates them is not the ceremony but what it buys.
>
> OTP **primary login** minted an `osn-access` session: every route in osn-api
> and every downstream service that verifies over JWKS. Its removal is why the
> phishing-resistance claim on this page holds. The recovery factors mint
> `aud: "osn-recovery"` — refused by all four verifiers in osn-api and by the
> three services outside this repo, accepted by exactly one resolver
> (`resolvePasskeyEnrollPrincipal`), absolutely expiring in fifteen minutes with
> no sliding extension, and refused by `verifyRefreshToken` unless the caller
> opts in, so it cannot complete an OIDC authorization either. It can enrol a
> passkey and nothing else, and enrolling one is what lifts the restriction.
>
> So the sign-in path's phishing resistance is unchanged: there is still no
> ceremony that turns an emailed code into an ordinary session. The bounded
> union `AuthMethod` in `@shared/observability` is pinned by a test that exists
> to keep it that way, and the pin now carries this argument rather than a bare
> list of members.

## The one bypass, and where it can exist

`GET|POST /dev/login` mints a real session for a single fixed principal without
any ceremony, so a **seeded** account is reachable at all — a seed script cannot
enrol a WebAuthn credential, which otherwise leaves every seeded row permanently
locked out. It is not a general relaxation: one hard-coded profile id, no
identifier parameter, nothing to enumerate.

It exists only where both gates pass, and both fail closed: the tier is `local`
or `dev`, and `DEV_LOGIN_SECRET` is set. Otherwise the routes are never mounted
and the path is a 404. `staging` and `production` can never mount it whatever
their secrets hold, and the production deploy job now **fails** while
`DEV_LOGIN_SECRET` is set on `osn-api-production`, so the secret cannot sit there
one edit away from a bypass. Both principal handles — `dev_bootstrap` and the
organisation's `dev_bootstrap_org` — are in `RESERVED_HANDLES`, which
organisation creation now consults as well, so no real registration can occupy
either row first. Full operator notes in [[dev-environment]] §5.

### The residual: the URL is a bearer credential (S-L3)

The whole point of the route is that one URL signs you in, which means the URL
**is** the credential. Anyone who reads it — a link pasted in chat, a shell
history, a synced browser bar, a screen share — can sign in as the principal on
the dev tier, and can hand a already-usable link to someone else: force-login and
session fixation, by forwarding. Two things narrow it and neither closes it:
`Referrer-Policy: no-referrer` on both verbs stops the secret leaving in a
`Referer`, and `return_to` is restricted to `DEV_LOGIN_RETURN_ORIGINS` (checked
*before* the secret compare, so a wrong secret redirects nowhere) so it cannot be
turned into an open redirect. Nothing in code stops a human forwarding the link.

So treat it like a password — never in an issue, a PR, or a chat, and rotate
`DEV_LOGIN_SECRET` if it appears in one. This is acceptable **because of where it
can exist**: the dev tier holds seeded weddings and no real guest data, and
production cannot mount the route at all. Filed open as `S-L3` in
`xchromo/osn-tracker` (#437); the four-field write-up is the issue body.

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
