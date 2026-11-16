---
"@tools/e2e": patch
---

`musubi-passkey` starts the sign-up again from a new tab of the same browser rather than with "Start again": it checks the browser's shared entry holds only the request, its retire secret and its expiry, that the new tab's begin sends that as `previous`, that the first request reads pending before and expired after, and that the entry goes once the account is made. It still begins two sign-ups.
