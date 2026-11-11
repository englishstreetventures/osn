---
"@osn/api": minor
"@osn/auth-ui": minor
"@osn/client": patch
"@shared/observability": minor
"@shared/rate-limit": minor
"@musubi/social": patch
"@tools/lab": patch
---

`@osn/api` answers the tab that began a sign-up, recovery or email change alike whatever the link's reader does: a decline, a wrong number, or a right one the account's lockout refuses ends the request (`declined` or `ended`) and keeps it until its expiry, its poll answering `pending` with the number and its Resend `sent` with nothing mailed, as for an address nobody was mailed; wrong link secrets there no longer end the request, and every one past the fifth is refused unread. A begin's first sign-up link counts against a per-mailbox restart window (ten an hour, `registration_restart`) when the begin carried `previous` or a sign-up to the mailbox was declined in the hour before; a plain first begin always mails. Step-up writes a `step_up_link_declined` security event on a decline and a `step_up_link_lockout` event when wrong numbers lock its links, with the `osn.auth.step_up.lockout` counter. Recovery's per-address link allowance keys an IPv6 client by its /64. `@shared/rate-limit` adds `clientNetwork`. `@shared/observability` adds the two event kinds. `@osn/auth-ui`'s waiting screen's way back reads "Start again" from the first moment, the link page's refusal and "Cancelled" copy sends a sign-up, recovery or email change back to it, and the security banner names a turned-down step-up request; `@osn/client` knows the kind. `@musubi/social`'s layout test and `@tools/lab`'s story name "Start again".
