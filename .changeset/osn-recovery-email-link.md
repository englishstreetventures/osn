---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": minor
"@musubi/social": minor
"@shared/email": minor
"@shared/observability": minor
---

Email account recovery uses an emailed link in place of the six-digit code. `POST /login/recovery/email/begin` answers every address alike with a request id, a claim secret and a pairing number (202), and mails `<frontend origin>/verify/<request id>#<link secret>` to an account's address. Whoever opens the link types the number the waiting screen shows (a blind guess is right 1 time in 100; a wrong number ends the request) or turns it down; confirming signs nobody in. The tab that began polls `POST /login/recovery/email/:requestId/status` with its claim secret and gets the restricted recovery session (passkey enrolment only), once; `POST /login/recovery/email/:requestId/resend` sends another link for the same request. `/login/recovery/email/complete` is gone.

`@osn/api` gives each emailed-link flow a pairing mode (sign-up picks among five candidates; recovery types the number), refuses a malformed pick like any other refusal, counts wrong typed numbers on the account's recovery lockout (five in 15 minutes) and wrong link secrets only on their request, records a `recovery_link_declined` security event, and caps recovery links at 3 a day per account and client address, 3 Resends a day per account and 20 links a day per account in all; the pending recovery-code store and its cap go. `@osn/client` replaces `emailRecoveryComplete` with `emailRecoveryStatus` and `emailRecoveryResend`, `emailRecoveryBegin` answers the request, and `emailLinkPurpose` knows recovery links. `@osn/auth-ui`'s `RecoveryLoginForm` waits on the link with `CheckEmailView`, survives a reload in the tab's `sessionStorage` (never the number), and exports `hasPendingRecovery`, which `SignIn` re-exports and opens on; `createLinkPoll` is the shared poll loop; `SignIn` and `RecoveryLoginForm` ask phones not to capitalise a typed identifier (`autocapitalize="none"`); the security banner names a turned-down recovery request. `@musubi/social` reopens sign-in for a pending recovery and asks for the number typed on a recovery link's page. `@shared/email` replaces `otp-recovery` with `link-recovery`. `@shared/observability` adds the recovery flow, its routes, the `email_resend` step and the `recovery_link_declined` event kind.
