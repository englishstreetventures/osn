---
"@musubi/infra": patch
---

Dev deploys allow 60 requests a minute on the shared 30-per-minute auth tier, so the consent page's context read no longer hits the per-IP limit. Production is unchanged.
