---
"@shared/email": minor
"@osn/api": patch
---

Add an optional `sendBatch` to `EmailService`: the Resend transport sends up to 100 emails in one `POST /emails/batch`, all or nothing, so a sender with a fixed budget of outbound requests (a Worker cron) can mail many people for one request. Existing `send` callers are unchanged.

Add the `rsvp-change-digest` email template: cire's daily note to a wedding's organisers that guests changed their RSVPs, with counts per kind of change, the wedding's name and a link to the organiser portal, and no guest name. `@osn/api` only rewords the documentation of the `account:email-read` scope and `POST /internal/accounts/emails`, whose one caller, cire-api, now also uses it for this digest; no behaviour changes.
