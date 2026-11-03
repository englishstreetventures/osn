---
"@cire/api": patch
---

The Stripe tests now pin the onboarding link request (address, method, form content type, account and return URLs, and no idempotency key) and refuse a link response missing its URL or expiry. They also assert that an `account.updated` or `account.application.deauthorized` delivery changes only the wedding that owns the account.
