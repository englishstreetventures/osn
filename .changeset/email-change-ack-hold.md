---
"@osn/api": patch
---

No step-up factor can acknowledge an `email_changed` security event for 7 days after the change it records (`EMAIL_CHANGE_ACK_HOLD_SECONDS`, the change cap's window); after that, any factor the gate admits can. `POST /account/security-events/:id/ack` on a held event answers 403 `{ "error": "email_change_held", "holdEndsAt": <unix seconds> }`, `POST /account/security-events/ack-all` acknowledges every other event and leaves it, and `GET /account/security-events` always lists it, beside the newest 50.
