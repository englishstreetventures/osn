---
"@tools/e2e": patch
---

The Musubi sign-up flows sign up through the emailed link: `linkFor` reads the link from the mail stand-in, `waitingScreenNumber` reads the number the first browser shows, and a second browser context opens the link and taps it (`confirmLinkOnPage`), and the first reaches the passkey step. `musubi-passkey` first spends a link on a wrong number (`pickWrongNumberOnPage`) and checks a `GET` on the link's routes approves nothing; `musubi-register-retry` declines its resent link (`declineLinkOnPage`). `registerThroughApi` confirms and claims over the API, and the budget guards count begins, resends and confirms.
