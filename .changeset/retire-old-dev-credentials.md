---
"@shared/infra": minor
---

`secrets:check-github -- --tier dev` now exits 1 when the `dev` Environment holds `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN_DEV`, the two names that point at the production account. `RETIRED_DEV_CREDENTIALS` replaces `RETIRING_DEV_CREDENTIALS`, `forbiddenCredentials()` forbids those names on every tier whose own account does not use them, and `allowedCredentials()` is gone. `knownCredentials()` leaves out `CLOUDFLARE_API_TOKEN_DEV`, so a workflow that reads it fails the package's tests.
