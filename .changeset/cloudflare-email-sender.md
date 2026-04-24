---
"@osn/api": minor
"@shared/email": minor
---

Switch email transport from Worker-proxy to Cloudflare Email Service REST API.

`@shared/email` `CloudflareEmailLive` now POSTs directly to `https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send` with a bearer token. Removes the ARC-token-signing intermediary and the `@shared/crypto` dependency. Error reason `worker_unreachable` renamed to `api_unreachable`.

`@osn/email-worker` is deleted — the Cloudflare Worker middleman is no longer needed since the REST API is available from any runtime, not just Workers.

`@osn/api` replaces `OSN_EMAIL_WORKER_URL` with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` env vars.
