---
"@osn/api": minor
"@osn/db": patch
"@osn/client": minor
---

A sign-up's session is restricted until the new account has its first passkey. The completing status poll now issues a session whose access tokens carry `osn-recovery`, so only `/passkey/register/*` accepts them; its cookie is no signed-in session to `/authorize` or to a `/token` grant for anything but its own rotation, and it lives 15 minutes. Its row records `signup`, which takes nobody past the step-up gate and stamps the first passkey `webauthn`. Enrolling lifts the restriction, and the sign-up funnel counts the first passkey as its `passkey_enroll` step. `@osn/client` exports `isRestrictedToken`, and its cold start publishes no session for a restricted cookie.
