---
"@tools/e2e": patch
---

`musubi-passkey`, `musubi-register-retry` and `musubi-recovery` check that the waiting tab keeps waiting after a wrong number or a decline on the link's page, then start again from the waiting screen; `musubi-passkey` and `musubi-recovery` send a new link from there and confirm it. `musubi-email-verification` presses "Start again".
