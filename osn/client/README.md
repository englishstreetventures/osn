# @osn/client

Client SDK for talking to an OSN identity server (`@osn/api`). Framework-
agnostic at the core, with an optional SolidJS integration under
`@osn/client/solid`.

## Exports

Every export is listed in [`src/index.ts`](src/index.ts) and
[`src/solid/index.ts`](src/solid/index.ts).

### REST clients

Each factory takes `{ issuerUrl }` and returns a client whose methods throw
its own error class, a subclass of `OsnApiError`.

| Factory | Source | Error class | Calls |
|---|---|---|---|
| `createRegistrationClient` | `register.ts` | `RegistrationError` | email-verified sign-up (`checkHandle`, `beginRegistration`, `completeRegistration`) and first-passkey enrolment; returns a `Session` |
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

### Errors and the session

- `OsnApiError` — the base of every error class above: `status` (the
  response's HTTP status, `0` when no response arrived) and `code` (the
  server's `error` code, when it sent one). `ProfileManagementError`
  carries the same two as optional fields.
- `describeAuthError(err, context?)` — one plain sentence for a failed
  call, read from `status` and `code` (and whether it is an expired
  session), never from the message. `context` (`code`, `recovery`,
  `passkey`, `new-passkey`, `details`) names what the person submitted.
- `isAuthExpiredError(err)` — whether `err` is, or wraps, an
  `AuthExpiredError`: `authFetch`'s failure when the access token has
  expired and a silent refresh failed.
- `OsnAuthService` (via `createOsnAuthLive`) — the Effect-based service
  that holds the persisted `Session`, handles silent-refresh on 401
  (`authFetch`), and drives profile management
  (`switchProfile`/`createProfile`/`deleteProfile`). Used by the SolidJS
  `AuthProvider`.

### `@osn/client/solid`

- `<AuthProvider>` + `useAuth()` — `session`, `logout`, `adoptSession`,
  `authFetch`, and the profile management methods.
- `<GraphProvider>` + `useGraph()`, `<OrgProvider>` + `useOrgs()` — the
  graph and organisation clients, given to the components below them.

## Consumed by

`@musubi/social` and `@osn/auth-ui` components (which inject client
instances via props).
