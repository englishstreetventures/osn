# @osn/client

Client SDK for talking to an OSN identity server (`@osn/app`). Framework-
agnostic at the core, with an optional SolidJS integration under
`@osn/client/solid`.

## Exports

- `createRegistrationClient({ issuerUrl })` — email-verified registration
  (`beginRegistration`, `completeRegistration`, `checkHandle`, passkey
  enrolment). Returns a `Session` directly.
- `createLoginClient({ issuerUrl })` — first-party sign-in via the
  `/login/*` endpoints (`passkeyBegin/Complete`, `otpBegin/Complete`,
  `magicBegin/Verify`). Returns a `Session` + `LoginUser`.
- `OsnAuthService` (via `createOsnAuthLive`) — the Effect-based service
  that drives the legacy PKCE redirect flow (`startLogin`, `handleCallback`,
  `refreshSession`, `adoptSession`). Used by third-party OAuth integrations
  and by the SolidJS `AuthProvider`.
- `@osn/client/solid` — `<AuthProvider>` + `useAuth()` hook exposing
  `session`, `login`, `logout`, `adoptSession`, `handleCallback`.

## Consumed by

`@pulse/app`, any future first-party OSN apps, and `@osn/ui/auth`
components (which inject client instances via props).
