---
"@osn/api": minor
"@shared/email": minor
---

Add `POST /internal/accounts/emails` to osn-api, which resolves OSN profile ids to the address of the account that owns each. It is ARC-authenticated behind a new `account:email-read` scope, capped at 100 ids per call, and omits any id it cannot answer for rather than saying why — so it is not an existence oracle. Adds the `registry-gift-summary` email template it exists to serve.
