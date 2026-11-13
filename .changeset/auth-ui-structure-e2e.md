---
"@tools/e2e": patch
---

`musubi-passkey` reads Settings → Security against probes (panel headings, a passkey row as a nested `Card`, its meta line, its actions on a phone, the disclosure's focus ring), takes the step-up's emailed link as far as its wait and back, removes the authenticator app through the step-up sheet with no browser dialog, and checks `/authorize`'s unframed panel and the app's name. The dialogs are found by their new names. `flows.test.ts` tells recovery flows by "Send the link" and caps step-up email begins at osn-api's five a minute.
