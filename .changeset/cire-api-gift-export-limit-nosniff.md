---
"@cire/api": patch
---

The gift-log download (`GET /api/organiser/weddings/:weddingId/gifts.csv`) has a per-user limit of its own, 3 a minute, checked before the 10 a minute every export shares. A gift download it refuses spends nothing from the shared allowance, and an owner's exports stay at 10 a minute in all. It keeps its gates: signed in, then owner only.

Every response the API's Elysia app builds carries `X-Content-Type-Options: nosniff`, set once in `createApp`: handler answers, refusals, the not-found and error answers, CORS preflights, and Responses a handler builds. The Worker's own misconfiguration 503 sets it too. The realtime route answers before the app, and its refusals have no body.
