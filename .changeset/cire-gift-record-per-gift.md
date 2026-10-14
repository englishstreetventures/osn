---
"@cire/api": patch
"@cire/host": patch
"@cire/db": patch
"@cire/invites": patch
"@cire/landing": patch
---

Gift record and currency guard:

- The retention sweep's parting summary keeps the amount, currency and day of
  each money gift (no household, name or note), at most 200 a wedding, and
  each currency's total carries the number of gifts it adds. One run lists at
  most 1,000 gifts; a wedding past that waits for the next run unless it is
  past the 30-day hold-back or has no money gift. Summaries are stored in
  statements of at most 60,000 characters, all in the delete's batch.
- The parting email puts each currency's count beside its own total, lists
  every money gift by its day, and marks one given in another currency as
  outside the couple's total. The portal's record band shows the same.
- Money gifts and the wedding's currency stay in step: switching money gifts
  on answers 409 `stripe_currency_unknown` until Stripe names the settlement
  currency; changing the wedding's currency while money gifts are on answers
  409 `currency_locked_by_cash_gifts`; the guest gate hides the money form
  unless the account settles in the wedding's currency. The portal explains
  each refusal.
- The live cash-gift total is no longer labelled approximate.
- The guest and couple privacy notices name the gift record kept after the
  year.
