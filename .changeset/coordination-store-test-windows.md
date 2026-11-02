---
"@shared/coordination": patch
---

Give the CoordinationStore workerd test's read-before-expiry check a 1 s TTL instead of 300 ms. A first call to a new object on a fresh CI runner has taken over 300 ms, so the read sometimes landed after the entry had expired.
