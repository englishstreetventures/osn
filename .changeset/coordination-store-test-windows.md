---
"@shared/coordination": patch
---

Stretch the CoordinationStore workerd test's TTLs and waits by one factor, so each wait leaves 450 ms either side of an expiry edge instead of 150 ms. A first call to a new object on a fresh CI runner has taken over 300 ms.
