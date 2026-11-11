# @osn/client

Client SDK for talking to an OSN identity server (`@osn/api`). Framework-
agnostic at the core, with an optional SolidJS integration under
`@osn/client/solid`.

## Exports

Every export is listed in [`src/index.ts`](src/index.ts) and
[`src/solid/index.ts`](src/solid/index.ts).

### REST clients

Each factory returns a client whose methods throw its own error class, a
subclass of `OsnApiError`. `createRegistrationClient`, `createEmailLinkClient`,
`createLoginClient` and `createAuthorizeClient` take `{ issuerUrl }`. Every other factory takes
`{ issuerUrl, authFetch }`, the page runtime's `authFetch`, and no method
takes an access token (the step-up gated ones take a `stepUpToken`).
`authFetch` sends only to the issuer's origin.

| Factory | Source | Error class | Calls |
|---|---|---|---|
| `createRegistrationClient` | `register.ts` | `RegistrationError` | sign-up through an emailed link (`checkHandle`, `beginRegistration`, `registrationStatus`, `resendRegistrationLink`) and first-passkey enrolment; the completing status poll returns a `Session` |
| `createEmailLinkClient` | `email-link.ts` | `EmailLinkError` | the calls the page an emailed link opens makes (`candidates`, `confirm`); `emailLinkPurpose(requestId)` reads a request id's flow |
| `createLoginClient` | `login.ts` | `LoginError` | passkey sign-in (`passkeyBegin`, `passkeyComplete`); returns a `Session` and a `LoginProfile` |
| `createStepUpClient` | `step-up.ts` | `StepUpError` | a fresh factor before a gated action: passkey, emailed code or authenticator app |
| `createPasskeysClient` | `passkeys.ts` | `PasskeysError` | list, rename, delete and add passkeys |
| `createTotpClient` | `totp.ts` | `TotpError` | add, remove and read the authenticator app |
| `createRecoveryClient` | `recovery.ts` | `RecoveryError` | recovery codes, sign-in by recovery code, emailed code or authenticator app, and undoing a recovery the owner did not start (`disown`) |
| `createAccountClient` | `account.ts` | `AccountError` | change the email; delete the account, cancel the deletion or read its state |
| `createSessionsClient` | `sessions.ts` | `SessionsError` | list and revoke signed-in sessions |
| `createSecurityEventsClient` | `security-events.ts` | `SecurityEventsError` | list and acknowledge security events |
| `createConnectionsClient` | `connections.ts` | `ConnectionsError` | list and revoke the apps the account has authorised |
| `createAuthorizeClient` | `authorize.ts` | `AuthorizeError` | the OIDC consent screen: read the request, post the answer |
| `createGraphClient` | `graph.ts` | `GraphClientError` | connections, requests and blocks between profiles |
| `createOrgClient` | `organisations.ts` | `OrgClientError` | organisations and their members |
| `createRecommendationClient` | `recommendations.ts` | `RecommendationClientError` | suggested connections and search |

A client that sends through `authFetch` lets a rejection about the session
(`AuthExpiredError`, `TokenRefreshError`, `ActiveProfileResetError`,
`StorageError`) and the caller's own abort reach the caller unchanged.

### The auth runtime and the session

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

### Errors

- `OsnApiError` — the base of every error class above: `status` (the
  response's HTTP status, `0` when no response arrived) and `code` (the
  server's `error` code, when it sent one). `ProfileManagementError`
  carries the same two as optional fields.
- `describeAuthError(err, context?)` — one plain sentence for a failed
  call, read from `status` and `code` (and whether it is an expired
  session), never from the message. `context` (`code`, `recovery`,
  `passkey`, `new-passkey`, `details`) names what the person submitted.
- `isAuthExpiredError(err)` — whether `err` is, or wraps, an
  `AuthExpiredError`: `authFetch`'s failure when the session has ended.

### `@osn/client/solid`

- `<AuthProvider auth={runtime}>` + `useAuth()` — `session`, `logout`,
  `adoptSession`, `authFetch`, and the profile management methods. It
  signs itself out when the runtime ends the session.
- `profiles` never throws when read. A list that fails to load keeps the
  last list it had (null before the first) and sets `profilesError`, which
  goes to `describeAuthError`; `refetchProfiles()` tries again. Losing the
  session in any way (signing out, an ended session, a reload that finds
  none) or adopting another account's session leaves neither the old list
  nor an error behind, even from a list still loading.

## Consumed by

`@musubi/social`, and `@osn/auth-ui` components (which take client
instances as props). Pulse and cire sign in through `@shared/rp-auth`
instead.
