---
"@tools/e2e": patch
---

The Musubi sign-up flows sign up through the emailed link: `linkFor` reads the link from the mail stand-in, a second browser context opens it and picks the number the first shows (`confirmLinkOnPage`), and the first reaches the passkey step. `registerThroughApi` confirms and claims over the API, and the budget guards count resends and confirms.
