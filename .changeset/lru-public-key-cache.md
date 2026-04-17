---
"@shared/crypto": patch
---

Upgrade `publicKeyCache` from FIFO to LRU eviction. On every cache hit the entry is re-inserted at the tail of the Map so the least-recently-used key is evicted under key-rotation churn rather than the oldest-inserted one (P-W25).
