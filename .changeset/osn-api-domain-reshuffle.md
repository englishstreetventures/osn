---
"@osn/api": patch
---

Domain reshuffle (organiser portal `app.cireweddings.com` → `host.cireweddings.com`):
add the new portal origin to osn-api's prod WebAuthn/CORS allowlists.
`[env.production].OSN_ORIGIN` and `OSN_CORS_ORIGIN` now list
`https://host.cireweddings.com,https://app.cireweddings.com` (both kept for the
switchover window; prune `app.` after the move + verify).

`OSN_RP_ID` stays `cireweddings.com` (the registrable apex), so existing organiser
passkeys keep working on the new subdomain with no re-registration — credentials
are scoped to the RP ID, not the full origin. osn-api is deployed MANUALLY (not
CI): run `cd osn/api && bunx wrangler deploy --env production` after this merges
for the var change to take effect.
