---
"@shared/realtime": minor
---

`onFallback` now receives why the subscription gave up: `refused` (the hub closed
the socket with 1008, which includes a revoked member) or `exhausted` (every
attempt failed); `FALLBACK_OUTCOMES` and `isFallbackOutcome` name them.
`sendFallbackBeacon` (`@shared/realtime/client`) posts that outcome to a
product's API. On the server, `readFallbackOutcome` reads a beacon body of at
most `MAX_FALLBACK_BEACON_BYTES`, and `recordClientFallback` counts the outcome
as `realtime.client.fallbacks` by product and outcome and logs a warning.
`subscribe()`'s doc now says the route must sit behind the product's per-IP
limit.
