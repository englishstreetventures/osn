---
"@cire/api": patch
"@cire/host": patch
"@tools/e2e": patch
---

cire-api sells a plan tier only where the platform webhook can grant it: the upgrade routes mount only with both `STRIPE_SECRET_KEY` and a non-blank `STRIPE_PLATFORM_WEBHOOK_SECRET`, and with the key and a Price id but no platform secret the Worker logs `upgrades disabled: STRIPE_SECRET_KEY is set without STRIPE_PLATFORM_WEBHOOK_SECRET` once when it builds the app. On a deployed tier, a platform secret equal to `STRIPE_WEBHOOK_SECRET` mounts no upgrade route either, and logs `upgrades disabled: STRIPE_PLATFORM_WEBHOOK_SECRET is the same value as STRIPE_WEBHOOK_SECRET`. The portal already reads the missing routes as nothing for sale; its comments now say so. The E2E stack carries a placeholder Gold Price, and the checklist flow presses a locked module's Upgrade to find nothing for sale.
