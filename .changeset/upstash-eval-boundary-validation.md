---
"@shared/redis": patch
---

Validate the Upstash `eval` reply against the RESP value space before returning it, instead of trusting the HTTP boundary's claimed type. Matches the check the ioredis path already runs through `toRedisReply`.
