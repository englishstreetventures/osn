---
"@tools/e2e": patch
---

`musubi-passkey`, `musubi-register-retry` and `musubi-recovery` check that the waiting tab keeps waiting after a wrong number or a decline on the link's page, then start again from the waiting screen and send a new link; `musubi-register-retry` checks the restart's link arrives. `musubi-email-verification` presses "Start again".
