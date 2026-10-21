---
"@cire/api": patch
"@cire/db": patch
---

The R2 reconcile test that walks workerd's cursor no longer fails on a busy
machine: it seeds its 1,005 objects in requests of 100 keys, because a single
long request left the next request on its keep-alive connection failing with
"The socket connection was closed unexpectedly". Four comments in the cire/db
schema drop their review-finding tags. Neither change alters what ships.
