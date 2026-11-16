---
"@tools/e2e": patch
---

New flow `musubi-account-deletion`: a person mails themselves a link to their data, deletes their Musubi account with their sole-owned cire wedding answered, downloads their data from the window screen, signs back in to that screen with their passkey, keeps the account (handle, passkey, Pulse enrolment back, wedding untouched), deletes everything, and the sweeps erase the account, hold the handle, delete the wedding and send the deleted email; the organisation they owned passes to its admin, who declines it from the email's link, and it passes to the next member. The osn seed adds `DELETION_PERSON` — an account, its profile, an open Pulse enrolment, a live session, and an organisation whose heir holds a live session too — and the stack's osn-api sweeps every 2 s. The fixtures export `suiteNow` and `writeOnce`, the one write a flow may make to a stack database.
