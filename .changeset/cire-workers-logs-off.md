---
"@cire/api": patch
"@cire/invites": patch
---

Turn off Workers invocation logs for cire-api (every tier) and cire-invites. An invocation record stores the request URL, and the public image and invite routes carry the wedding slug in the path. Application logs stay on. The image `cache.put` warning now logs the error name instead of its message, which could echo the cache key.
