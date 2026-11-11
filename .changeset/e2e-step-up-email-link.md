---
"@tools/e2e": patch
---

`musubi-step-up-email` steps up for an account export through a link to the dev profile's own address, typed on a second browser's `/verify` page, exports with the token the first browser's poll receives once, then moves the account to a new address through a link picked at that address and a passkey step-up for `email_change`, and checks the account row holds it. `linkFor` reads step-up and email-change links, and the source guards count the new confirms and the second Musubi sign-in.
