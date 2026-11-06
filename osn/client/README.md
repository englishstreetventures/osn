# @osn/client

Client SDK for talking to an OSN identity server (`@osn/api`). Framework-
agnostic at the core, with an optional SolidJS integration under
`@osn/client/solid`.

## Exports

- `createRegistrationClient({ issuerUrl })` — email-verified registration
  (`beginRegistration`, `completeRegistration`, `checkHandle`, passkey
  enrolment). Returns a `Session` directly.
- `createLoginClient({ issuerUrl })` — sign-in via the `/login/*`
  endpoints (`passkeyBegin/Complete`, `otpBegin/Complete`,
  `magicBegin/Verify`). Returns a `Session` + `LoginUser`.
- `createOsnAuthRuntime({ issuerUrl }, { storage? })` — the page's one
  auth runtime: a `ManagedRuntime` over a single `OsnAuthService`. Its
  `authFetch` sends the active profile's access token and renews it before
  it expires and on a 401, naming the active profile in the grant;
  `onSessionChange` tells listeners when it ended the session or reset the
  active profile. Build it once per page.
- `OsnAuthService` (via `createOsnAuthLive`) — the Effect-based service
  behind the runtime: the persisted account, the single-flight `/token`
  grant, `authFetch`, and profile management
  (`switchProfile`/`createProfile`/`deleteProfile`).
- Authenticated clients — `createGraphClient`, `createOrgClient`,
  `createRecommendationClient`, `createSessionsClient`,
  `createSecurityEventsClient`, `createConnectionsClient`,
  `createPasskeysClient`, `createTotpClient`, `createStepUpClient`,
  `createRecoveryClient`, `createAccountClient`. Each takes
  `{ issuerUrl, authFetch }`, and no method takes an access token (the
  step-up gated ones take a `stepUpToken`). `authFetch` sends only to the
  issuer's origin.
- `@osn/client/solid` — `<AuthProvider auth={runtime}>` + `useAuth()` hook
  exposing `session`, `logout`, `adoptSession`, `authFetch`, and the profile
  management methods. It signs itself out when the runtime ends the session.

## Consumed by

`@musubi/social`, and `@osn/auth-ui` components (which take client
instances as props). Pulse and cire sign in through `@shared/rp-auth`
instead.
