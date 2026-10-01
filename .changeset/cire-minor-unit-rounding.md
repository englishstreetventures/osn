---
"@cire/host": patch
---

Round typed money amounts to the currency's minor unit by decimal rules, so 1.005 AUD is 101 cents rather than 100. A positive amount that rounds to zero minor units (¥0.4, 0.0004 KWD) is now refused with "Amounts between 0 and ¥1 are not allowed." in the Budget tab, the per-head price and the gift list's price inputs. A typed 0 is still allowed.
