---
"@cire/infra": minor
"@cire/api": patch
"@cire/invites": patch
---

The cire stack declares cire-api, the guest site, the database and both buckets on production, adopting each by its existing name, so every cire Worker deploys through the stack. A release migrates the database with Wrangler before the deploy, and production secrets stay on the Worker. `read:live` reads what the stack's adopted resources hold live, for the plan guard and for the check after a deploy. cire-api has no hand-deploy script, and the guest site's build ships through the stack on every tier.
