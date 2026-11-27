---
"@musubi/infra": patch
---

The dev tier's osn-api sends account email as `Musubi (dev) <dev@musubi.social>`, so a dev test email no longer reads as a real one and its bounces stay off production's `Musubi <hello@musubi.social>`.
