---
"@cire/api": patch
"@cire/db": patch
---

A vendor's quote in the enquiry chat message and the `enquiry-quote` email prints with the wedding currency's own minor unit: ¥50,000 for a yen quote of 50,000 minor units, where it printed ¥500, and 1.500 KWD for 1,500 fils, where it printed 15.000. Two-decimal currencies print as before. In `@cire/db`, the comment on `weddings.budget_total_minor` says a minor unit is not always a hundredth.
