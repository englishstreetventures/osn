---
"@shared/infra": patch
---

cire-api's dev secret inventory declares `STRIPE_CONNECT_CLIENT_ID` (the Stripe Connect OAuth client id) while it holds a value. Both tiers forbid `STRIPE_API_URL` and `STRIPE_CONNECT_URL`, which point Stripe calls at a local stand-in.
