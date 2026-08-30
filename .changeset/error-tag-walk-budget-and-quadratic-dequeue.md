---
"@osn/api": patch
---

Fix `publicError`'s `_tag` walk to stop charging the 512-node traversal budget for primitive property values, so a wide chain of string fields no longer exhausts the budget before a real tagged error is found and misreported as a 400. Also replace the queue's `Array#shift()` with a read cursor, so the walk is linear in the number of nodes visited instead of quadratic.
