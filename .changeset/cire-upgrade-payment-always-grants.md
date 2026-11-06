---
"@cire/api": minor
"@cire/db": minor
"@cire/host": patch
---

A paid upgrade checkout of cire's own now upgrades the wedding or is refunded
automatically; nobody is charged for nothing. Settle trusts the session the
purchase row holds rather than the amount: any amount Checkout charged grants,
and a payment for any other session grants nothing and is not refunded. When a
paid checkout cannot grant (the product names no tier, the wedding is deleted, a
from-tier purchase finds the wedding lowered below that tier, or the wedding
already holds the tier), the purchase moves to `refunding` and is refunded
through Stripe (`POST /v1/refunds`, one idempotency key per purchase), recorded
as `auto_refunded` with the refund id. A daily reconciliation (cron job 13)
retries refused refunds, settles paid sessions whose webhook never landed, and
hands a refund that keeps failing to a person (`refund_failed`); the platform
endpoint handles `refund.failed`. `@cire/db` gains `refund_id` and a
`(status, updated_at)` index on `wedding_upgrade_purchases`. The portal's
return poll ends on an automatic refund, with the contact address from
`@shared/legal`, and on a refund a person made.
