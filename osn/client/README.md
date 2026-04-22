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
- `OsnAuthService` (via `createOsnAuthLive`) — the Effect-based service
  that holds the persisted `Session`, handles silent-refresh on 401
  (`authFetch`), and drives profile management
  (`switchProfile`/`createProfile`/`deleteProfile`). Used by the SolidJS
  `AuthProvider`.
- `@osn/client/solid` — `<AuthProvider>` + `useAuth()` hook exposing
  `session`, `logout`, `adoptSession`, `authFetch`, and the profile
  management methods.

## Consumed by

`@pulse/app`, any future first-party OSN apps, and `@osn/ui/auth`
components (which inject client instances via props).
