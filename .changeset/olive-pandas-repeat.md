---
"@shared/crypto": patch
---

Order the ARC public-key cache by an access counter instead of `Date.now()`. Back-to-back cache accesses land in the same millisecond, so the eviction scan saw a tie, kept whichever key it iterated first, and could throw away a just-used entry instead of the least recently used one. The counter gives a total order and costs less than a clock read on the hot path. Also fixes the LRU test that failed about three runs in ten because of it.
