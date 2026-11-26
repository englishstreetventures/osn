---
"@tools/e2e": patch
---

`musubi-change-notice` sends a change notice of the suite's own to every account the stack's osn-api holds, and checks each got it once. The mail stand-in answers an armed address in a permissive batch's `errors`, records each batch's idempotency key and validation mode, keeps each message's HTML, and lists every message at `GET /__e2e/mail/all`.
