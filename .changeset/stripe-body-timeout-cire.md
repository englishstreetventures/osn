---
"@cire/api": patch
---

The Stripe call timeout now covers reading the response body as well as the request, so a stalled body fails as a timeout.
