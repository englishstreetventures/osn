---
"@shared/infra": patch
---

The test that holds the secrets Environment-bound jobs read knows Environments outside the tiers: `stripe-test-mode` may give its job `STRIPE_TEST_SECRET_KEY` and nothing else, and a read from any Environment that is neither a tier nor listed still fails.
