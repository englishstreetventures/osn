---
"@cire/api": patch
"@cire/db": patch
---

A money gift keeps the Stripe account it was paid into. `registry_contributions` gains `stripe_account_id` and `stripe_account_type`, back-filled from the wedding's settings row for gifts that have a Checkout session and were made after its last deauthorization and not before its current account was connected, and filled by a trigger for a gift a Worker from before the migration inserts. Gift events (settle, failure, refund, dispute) match a gift by its own recorded account, and fall back to the wedding's current account only for a gift with none; the Standard-account adoption rule reads the gift's own type. The contribute route records the account and type with the gift, hands back an open page only on the account the gate approved, and puts the account in the checkout idempotency key. `registry_settings` gains `stripe_account_generation`, raised by a trigger each time the account id is cleared; the account-create key becomes `cire-account-<weddingId>-<generation>`, and the attach writes only while the row still holds the generation the session route read, answering 409 `stripe_account_changed` otherwise.
