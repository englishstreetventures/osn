---
"@osn/client": major
"@osn/auth-ui": major
"@musubi/social": patch
---

A page's session now outlives its access token. `createOsnAuthRuntime({ issuerUrl })` builds the page's one auth service, and its `authFetch` sends the active profile's token and renews it: before the token expires, and once on a 401. Renewal keeps the active profile, switching the renewed token back to it before anything is sent. Only a refusal ends the session: the stored account is cleared, `AuthProvider` goes to signed out, and the call rejects with `AuthExpiredError`. A grant the issuer marks as a lost rotation race or a storage error is retried once; a renewal that cannot reach the issuer rejects that one call with `TokenRefreshError` and keeps the session; a profile switch the issuer refuses makes the default profile active and rejects with `ActiveProfileResetError`. A tab adopts a token another tab already renewed for the same profile, and ends its session when another tab removes the stored account. A request that fails or is aborted rejects with what `fetch` gave.

Breaking: `AuthProvider` takes `auth` (the runtime) in place of `config` and `storage`. Every authenticated client (`createGraphClient`, `createOrgClient`, `createRecommendationClient`, `createSessionsClient`, `createSecurityEventsClient`, `createConnectionsClient`, `createPasskeysClient`, `createTotpClient`, `createStepUpClient`, `createRecoveryClient`, `createAccountClient`) takes `{ issuerUrl, authFetch }`, and no method takes an access token. `GraphProvider` and `OrgProvider` take `issuerUrl` and use the provider's `authFetch`. The `@osn/auth-ui` views (`SessionsView`, `PasskeysView`, `TotpView`, `RecoveryCodesView`, `SecurityEventsBanner`, `ChangeEmailForm`, `StepUpDialog`) drop the `accessToken` prop.

Musubi builds one runtime, `osnAuth`, hands it to both of its providers and builds every authenticated client with its `authFetch`. Settings, connections, organisations, discovery and search keep working past five minutes, and a refused renewal shows the signed-out page.
