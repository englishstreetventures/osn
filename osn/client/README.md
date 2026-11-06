# @osn/client

Client SDK for talking to an OSN identity server (`@osn/api`). Framework-
agnostic at the core, with an optional SolidJS integration under
`@osn/client/solid`.

## Exports

- `createRegistrationClient({ issuerUrl })` — email-verified registration
  (`beginRegistration`, `completeRegistration`, `checkHandle`, passkey
  enrolment). Returns a `Session` directly.
- `createLoginClient({ issuerUrl })` — passkey sign-in via the
  `/login/passkey/*` endpoints (`passkeyBegin`, `passkeyComplete`).
  Returns a `Session` + `LoginProfile`.
- `OsnAuthService` (via `createOsnAuthLive`) — the Effect-based service
  that holds the persisted `Session`, handles silent-refresh on 401
  (`authFetch`), and drives profile management
  (`switchProfile`/`createProfile`/`deleteProfile`). Used by the SolidJS
  `AuthProvider`.
- `@osn/client/solid` — `<AuthProvider>` + `useAuth()` hook exposing
  `session`, `logout`, `adoptSession`, `authFetch`, and the profile
  management methods.
- `OsnApiError` — the base of every REST client's error class: `status`
  (the response's HTTP status, `0` when no response arrived) and `code`
  (the server's `error` code, when it sent one). `ProfileManagementError`
  carries the same two as optional fields.
- `describeAuthError(err, context?)` — one plain sentence for a failed
  call, read from `status` and `code` alone and never from the message.
  `context` (`code`, `recovery`, `passkey`, `details`) names what the
  person submitted.

## Consumed by

`@musubi/social` and `@osn/auth-ui` components (which inject client
instances via props).
