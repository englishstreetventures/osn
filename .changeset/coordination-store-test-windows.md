---
"@shared/coordination": patch
---

Give the CoordinationStore workerd test's two checks that must land before a TTL ends a 1 s TTL instead of 300 ms: the read before expiry, and the three alarms still set after first calls to three new objects. A first call to a new object on a fresh CI runner has taken over 300 ms.
