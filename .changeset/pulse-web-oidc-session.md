---
"@pulse/web": minor
"@shared/rp-auth": minor
"@pulse/api": patch
---

Sign Pulse web in through the OSN OIDC redirect flow, with the browser holding a Pulse session cookie instead of an access token.

The WebAuthn RP ID is `musubi.social`, so a Pulse origin can no longer run a passkey ceremony. Pulse web now sends people to the OSN authorize endpoint and the Pulse API completes the code exchange, then sets its own host-scoped HttpOnly session cookie. The browser never sees an OSN token.

- `useAuth()` comes from `@shared/rp-auth/solid` and returns `{ session, activeProfileId, authFetch, signIn, logout, refresh }`. `RpSession` carries identity fields only — no `accessToken`.
- Every `pulse/web/src/lib` call drops its token argument; the cookie authorises the request. Resources that keyed on the token now key on the viewer's profile id.
- Close friends: the browser can't read the OSN graph, so Pulse serves the candidate list. `listCloseFriendCandidates()` returns `null` when the graph is unreachable, which the page reports as a failure rather than an empty list.
- Settings drops the handle-setup card. Name, handle and email belong to the musubi account and are edited there.
- `AuthErrorToast` surfaces a failed or declined sign-in from the `?auth_error=` marker the callback leaves behind.
- Removes `src/lib/authClients.ts` and the `@simplewebauthn/browser` dependency from the web app.
- `createClient` in `@pulse/api` takes an optional Eden treaty config, so a browser caller can set `credentials: "include"`.

Deploy note: the Pulse API must be same-site with the web origin (`api.<pulse-domain>`), or the `SameSite=Lax` session cookie is never sent.
