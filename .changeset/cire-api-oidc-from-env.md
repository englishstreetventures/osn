---
"@cire/api": patch
---

Organiser sign-in is configured by one function in the Worker and the local Bun server: `oidcConfigFromEnv` (`lib/oidc.ts`) builds it from `OSN_ISSUER_URL`, `OSN_JWKS_URL`, `CIRE_API_ORIGIN`, `CIRE_OIDC_CLIENT_ID` and `CIRE_OIDC_CLIENT_SECRET`, all five or none. The Bun server still takes the issuer's own JWKS path when `OSN_JWKS_URL` is unset. With none, `/api/auth/oidc/*` sends the browser back to the organiser login page with `sign_in_unavailable`, as before. The local server adds three Gold organiser weddings owned by the dev profile when the E2E stack sets `CIRE_E2E_ORGANISER=1`, and nothing otherwise.
