---
"@shared/redis": patch
---

Narrow Upstash GET, PING and DEL replies at the HTTP boundary so a wrapper that hands back a non-string or non-integer fails with a message naming the adapter, command and arriving type instead of a TypeError further downstream. Send EVALSHA after the first EVAL of a script, keeping the digest per client and reloading the body only on NOSCRIPT. Skip rebuilding an EVAL array reply when every element is already a RESP value.
