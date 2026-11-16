---
"@tools/e2e": patch
---

New flow `musubi-account-deletion`: a person deletes their Musubi account with their sole-owned cire wedding, sees the window screen on the next sign-in, keeps the account (handle, passkey, Pulse enrolment back, wedding untouched), deletes everything, and the sweeps erase the account, hold the handle, delete the wedding and send the deleted email. The osn seed adds `DELETION_PERSON` — an account, its profile, an open Pulse enrolment and a live session the flow signs in with — and the stack's osn-api sweeps every 2 s. The fixtures export `suiteNow` and `writeOnce`, the one write a flow may make to a stack database.
