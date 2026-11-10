---
"@osn/api": patch
"@shared/email": patch
"@shared/observability": patch
---

Completing an email change now mails the address it replaced and records an `email_changed` security event, as the other credential changes do. The event is written in the same batch as the change and only when the change is on record, with the device and hashed IP of the request that made it, so `GET /account/security-events` lists it. The notice, the new `email-changed` template, names the new address masked (`a•••@example.com`) and keeps it out of the subject; it goes out after the commit with a 10-second timeout, so a slow or failing mailer never delays or fails the change, and it still goes out when the commit reports a failure for a change that stands. The swap moves the address only while the account holds the address the request read, so the address mailed is the one the change replaced. Acknowledging one security event, or all of them, is one guarded write that reports and counts the rows it changed. `SecurityEventKind` gains `email_changed`, and the security-event module gains `notifySecurityEventTo` for a notice to an address the account no longer holds.
