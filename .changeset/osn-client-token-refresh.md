---
"@osn/client": major
"@osn/auth-ui": major
"@osn/api": minor
"@musubi/social": patch
---

A page's session now outlives its access token. `createOsnAuthRuntime({ issuerUrl })` builds the page's one auth service, and its `authFetch` sends the active profile's token and renews it: before the token expires, and once on a 401. Only a refusal ends the session: the stored account is cleared, `AuthProvider` goes to signed out, and the call rejects with `AuthExpiredError`. A grant whose body names a lost rotation race or a storage error is retried once. A renewal that cannot reach the issuer, or is rate limited, keeps the session: the request goes out with the token in hand while it is valid, otherwise the call rejects with `TokenRefreshError`, and renewal then pauses (the issuer's `Retry-After`, or 2 s doubling to 30 s) so no call in the pause sends a grant. A tab adopts a token another tab already renewed for the same profile, and ends its session when another tab removes the stored account. A request that fails or is aborted rejects with what `fetch` gave; a URL off the issuer's origin is refused with a `TypeError` before anything is sent.

`POST /token` takes an optional `profile_id`, and renewal names the active profile in it: the issuer mints for that profile when the session's account owns it, and for the default profile otherwise, so renewal is one request and spends no profile switch. A grant that comes back for the default profile means the account does not own the active one: the default profile becomes active and the call rejects with `ActiveProfileResetError`. A restricted recovery session ignores the field.

Breaking: `AuthProvider` takes `auth` (the runtime) in place of `config` and `storage`. Every authenticated client (`createGraphClient`, `createOrgClient`, `createRecommendationClient`, `createSessionsClient`, `createSecurityEventsClient`, `createConnectionsClient`, `createPasskeysClient`, `createTotpClient`, `createStepUpClient`, `createRecoveryClient`, `createAccountClient`) takes `{ issuerUrl, authFetch }`, and no method takes an access token. `GraphProvider` and `OrgProvider` are removed. The `@osn/auth-ui` views (`SessionsView`, `PasskeysView`, `TotpView`, `RecoveryCodesView`, `SecurityEventsBanner`, `ChangeEmailForm`, `StepUpDialog`) drop the `accessToken` prop.

Musubi builds one runtime, `osnAuth`, hands it to both of its providers and builds every authenticated client with its `authFetch`. Settings, connections, organisations, discovery and search keep working past five minutes, and a refused renewal shows the signed-out page.
