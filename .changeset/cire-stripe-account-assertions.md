---
"@cire/api": patch
---

The Stripe tests now assert that an onboarding link request carries no idempotency key, and that an `account.updated` delivery changes only the wedding that owns the account.
