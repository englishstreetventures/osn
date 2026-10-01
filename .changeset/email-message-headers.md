---
"@shared/email": minor
---

A renderer can now return message headers, and the Resend transport sends them on single and batch sends. The RSVP change digest uses this: given a signed `stopUrl`, it links it in both bodies and carries `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) so a mail client can offer one-click unsubscribe. The Cloudflare and log transports do not send headers.
