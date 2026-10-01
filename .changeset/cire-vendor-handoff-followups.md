---
"@cire/api": patch
"@cire/db": patch
---

A failed hand-off of a buffered vendor enquiry keeps its Zap chat in the new nullable `vendor_enquiries.handoff_chat_id` (migration 0075), so the next day's retry reuses that chat instead of provisioning another, and skips the send when the body already landed. The daily cron also emails the operator a count of vendor claims waiting for review when the `CIRE_OPS_EMAIL` secret and Resend are configured.
