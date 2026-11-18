---
"@tools/e2e": patch
---

`bun run test:e2e:stripe` runs the guest's gift to a cash fund against a Stripe sandbox instead of the stand-in: cire-api opens the Checkout session at Stripe, the flow pays it with Stripe's test card, `stripe listen` forwards the event Stripe signs to the Connect webhook, the gift settles, the stand-in's answers are compared with Stripe's field by field, and the payment is refunded. The run starts the suite clock at the real now and refuses any key that is not a test-mode one. `cire-registry-money`'s fund journey shares its owner and guest steps with it and records the same.
