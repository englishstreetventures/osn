---
"@shared/email": patch
"@osn/api": patch
---

The Resend transport logs every failed send as `email.dispatch_failed` (template, reason, HTTP status, Resend's error code and a fixed reading of its message, never the recipient, message text or key) and every send a caller's timeout cuts off as `email.dispatch_interrupted`. A send a caller's timeout cuts off aborts its request, and a refusal's error body is read only up to 4096 bytes. When a sign-up code's send fails or takes over ten seconds, osn-api answers the sign-up as it answers every other one. A refused send removes that request's pending entry, so the next "Resend code" sends a new code; a send that timed out or never got an answer, whose code may still arrive, holds the entry for one minute.
