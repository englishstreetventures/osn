---
"@cire/api": patch
---

Organiser sign-in is configured the same way in the Worker and the local Bun server: `oidcConfigFromEnv` builds it from `OSN_ISSUER_URL`, `OSN_JWKS_URL`, `CIRE_API_ORIGIN`, `CIRE_OIDC_CLIENT_ID` and `CIRE_OIDC_CLIENT_SECRET`, all five or none. With none, `/api/auth/oidc/*` sends the browser back to the organiser login page with `sign_in_unavailable`, as before. `bun run dev:cire` can now sign an organiser in when those values and a matching OSN client row are present. The local server adds three Gold organiser weddings owned by the dev profile when the E2E stack sets `CIRE_E2E_ORGANISER=1`, and nothing otherwise.
