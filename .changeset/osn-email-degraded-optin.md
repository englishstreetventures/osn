---
"@shared/email": patch
"@osn/api": patch
---

Allow osn-api to boot in non-local environments WITHOUT Cloudflare email as an explicit opt-in.

By default osn-api still fails closed at startup when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` are absent in a non-local env. Setting the new non-secret boolean `OSN_EMAIL_OPTIONAL=true` now lets it boot with a no-op email transport (`makeNoopEmailLive` in `@shared/email`) that discards transactional mail and emits a loud, redacted startup warning instead of throwing. Cloudflare creds always win when present. Transport selection is centralised in `osn/api/src/lib/email-layer.ts` (shared by the Bun and Workers entries).
