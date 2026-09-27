---
"@shared/realtime": minor
---

`onFallback` now receives why the subscription gave up: `refused` (the hub closed
the socket with 1008) or `exhausted` (every attempt failed). `sendFallbackBeacon`
(`@shared/realtime/client`) posts that outcome to a product's API, and
`recordClientFallback` (`@shared/realtime/server`) counts it as
`realtime.client.fallbacks` by product and outcome and logs a warning.
