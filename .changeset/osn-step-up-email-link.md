---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": minor
"@musubi/social": minor
"@shared/email": minor
"@shared/observability": minor
"@osn/db": patch
---

Step-up and email change confirm by an emailed link in place of the six-digit code. `POST /step-up/email/begin` (Bearer, `{ purpose }`) mails a link to the account's own address for that one purpose and answers a request id, a claim secret and a number; whoever opens the link types the number, and the tab that began, signed in as the same account, polls `POST /step-up/email/:requestId/status` and gets a step-up token for that purpose, once (`amr: ["otp"]`, the emailed factor, so never accepted at `passkey_delete`). `POST /account/email/begin` mails a link to the new address and answers the same shape whether or not another account holds it; its status answers `confirmed` once the link is picked, and `POST /account/email/:requestId/complete` with a step-up token for `email_change` moves the account and revokes its other sessions. `/step-up/otp/*` and `/account/email/complete` are gone, with the code store, templates and dev log line.

`@osn/api` counts wrong typed step-up numbers on a per-account lockout (five in 15 minutes: no step-up link mailed, a right number refused), counts wrong email-change picks on the per-address link lockout sign-up uses, caps step-up links at 10 a day per account and Resends of both at 3 a day per mailbox (`+tag` and Gmail dots folded). `@osn/client` replaces `otpBegin`/`otpComplete` with `emailBegin`, `emailStatus` and `emailResend`, and gives the account client `changeEmailStatus`, `changeEmailResend` and a request-based `changeEmailComplete`; `emailLinkPurpose` knows step-up and email-change links. `@osn/auth-ui`'s `StepUpDialog` offers "Use email instead" under the passkey and waits on the link with `CheckEmailView` (no purpose, no email factor); `ChangeEmailForm` waits on the new address's link, then steps up and completes. `@musubi/social` asks for the number typed on a step-up link's page. `@shared/email` replaces `otp-step-up` and `otp-email-change` with `link-step-up` and `link-email-change`. `@shared/observability` adds the two flows, their routes and the `resend` steps. `@osn/db` updates a schema comment.
