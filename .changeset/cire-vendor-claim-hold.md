---
"@cire/api": minor
"@cire/db": minor
"@cire/vendor": minor
---

Hold a redeemed vendor directory claim for an operator. The listing stays unowned and off the directory, and couples' enquiries stay buffered, until an operator confirms the claim with `scripts/cire-vendor-claim-review.ts`; the daily cron then hands the buffered enquiries to the vendor. The vendor portal shows the listing as awaiting confirmation.
