---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": minor
"@musubi/social": minor
"@shared/email": minor
"@shared/observability": minor
---

Sign-up proves the address with an emailed link in place of the six-digit code. `POST /register/begin` answers a request id, a claim secret and a pairing number, and mails `<frontend origin>/verify/<request id>#<link secret>`; the link's page reads the candidates (`POST /email-link/:requestId/candidates`) and confirms (`POST /email-link/:requestId/confirm`) with the number picked, since the confirm step requires the number shown on the waiting screen; "I didn't ask for this" ends the request and answers `declined`, again when repeated. Confirming never signs anyone in: the tab that began polls `POST /register/:requestId/status` with its claim secret, which answers the number while it waits, and gets the account and session once; `POST /register/:requestId/resend` sends another link for the same request. `/register/complete` is gone.

`@osn/api` adds the shared email-link challenge for every flow that emails a link, the `email_link` ceremony store, the `registration_link_lockout` counter and the `registrationSendCap` limiter, both keyed on the address's mailbox key (`mailboxKey`), which feeds no stored or mailed address. `POST /register/begin` holds `previous` to the request-id and secret patterns the status and resend routes use. `@osn/client` replaces `completeRegistration` with `registrationStatus` and `resendRegistrationLink`, and adds `createEmailLinkClient` and `emailLinkPurpose`. `@osn/auth-ui`'s `Register` waits on the link with `CheckEmailView`, survives a reload in the tab's `sessionStorage` (the number is never stored; the first poll after a reload brings it back), and exports `hasPendingSignUp`, which also lives in the component-free `@osn/auth-ui/pending-sign-up` so a page can ask without loading `Register`. `@musubi/social` serves the link's page at `/verify/:requestId` with `ConfirmLinkPage`. `@shared/email` replaces `otp-registration` with `link-registration`. `@shared/observability` adds the email-link metric attributes and redacts the link and claim secrets and the pairing values.
