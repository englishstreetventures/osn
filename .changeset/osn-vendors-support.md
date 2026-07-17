---
"@osn/api": patch
"@shared/email": patch
---

Add `org:read` to the register-service permitted-scopes allowlist in `@osn/api` so downstream services (cire-api) can resolve OSN org membership over ARC for the Vendors feature. Add the `vendor-claim-invite` transactional email template to `@shared/email` (fail-soft: sent on claim-token minting; missing `RESEND_API_KEY` degrades to a logged no-op).
