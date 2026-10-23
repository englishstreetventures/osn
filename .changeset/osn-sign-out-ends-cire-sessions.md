---
"@osn/api": minor
"@shared/infra": minor
"@musubi/infra": patch
"@shared/dev-urls": patch
---

Signing out everywhere else, and revoking cire's connection, now also end the account's cire organiser sessions. After the OSN side succeeds, osn-api asks cire-api's `POST /internal/revoke-organiser-sessions` to end the sessions of every profile on the account, in the background, so the response never waits for cire. Revoking any other app's connection leaves cire alone. A refused or failed call is an error log and an `osn.auth.cire_session.revocations` count; nothing retries it.

osn-api reads three new settings: `CIRE_INTERNAL_REVOKE_URL` (cire-api's origin), `CIRE_OIDC_CLIENT_ID` (`cid_cire`) and the optional secret `CIRE_INTERNAL_REVOKE_SECRET`, which cire-api must hold too. With the URL or secret unset, each such request logs a warning and sends nothing. The secret inventory holds the secret as optional on osn-api and cire-api on both tiers, as one shared value, at least 32 characters on dev. The musubi dev stack sets the URL and client id, and `bun run dev` gives osn-api the local cire-api's URL.
