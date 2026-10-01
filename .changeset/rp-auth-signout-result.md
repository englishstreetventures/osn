---
"@shared/rp-auth": patch
---

`signOut` now resolves `true` when the server confirmed the sign-out and `false` on a network failure or any non-2xx status. It still never throws.
