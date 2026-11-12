---
"@tools/e2e": patch
---

`musubi-recovery` gets back into a seeded account whose only passkey is lost through an emailed link: a reload keeps the wait, a `GET` on the link's routes approves nothing, a wrong typed number ends the first request, the second is turned down, and the number typed on the third confirms; the first browser gets the restricted session, adds a passkey and signs in with it, and the second never holds a session. `linkFor` reads recovery links too, `typeNumberOnPage` types a number on the link's page, and the source guards hold the flows to three recovery links from the run's address and count typed confirms.
