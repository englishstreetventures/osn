---
"@cire/api": minor
"@cire/db": minor
"@tools/e2e": patch
---

Each automatic upgrade refund now has a record outside the wedding's cascade
(`platform_refunds` in `@cire/db`: the purchase id, product, PaymentIntent,
amount, reason, status, Stripe refund id and when the owners were mailed),
written in the refund claim's batch. The purge no longer holds a deleted
wedding for a refund cire owes: the daily reconciliation and `refund.failed`
work from the record once the purchase row is gone. Once Stripe accepts a
refund cire made, every owner of the wedding is emailed once (`upgrade-refund`),
and `owners_notified_at` is written only when the mail went out. The daily
reconciliation works one queue, oldest first, across refunds and stale
checkouts. The local cire-api resolves owners' addresses through osn-api when
it has an ARC key and a local Resend, and the E2E stack now sells Gold: a flow
buys it through a Stripe stand-in that serves Checkout and refunds, and a
second checkout, on a wedding deleted while it was open, is refunded and its
owners mailed.
