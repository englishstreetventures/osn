---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

Mail the couple their registry gift summary at the moment the retention sweep deletes the per-gift detail. The sweep asks osn-api for the address of the account that owns the wedding (cire stores none of its own) and sends one email per wedding through the new `registry-gift-summary` template. Delivery is best-effort and never blocks the deletion: no address, no mail, and the sweep runs on.

The kept summary now has a read path as well: the organiser's registry settings show the dated record of what was given once the detail is gone. Two fixes to the gift path go with it — a refund now settles the contribution that names the payment intent rather than the first row that matches it, and the contribution row is written before the Stripe checkout session opens, so a payment can no longer arrive for a gift that was never recorded.
