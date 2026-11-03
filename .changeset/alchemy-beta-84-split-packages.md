---
"@shared/infra": patch
"@musubi/infra": patch
"@pulse/infra": patch
"@zap/infra": patch
---

Alchemy moves to `2.0.0-beta.84`, with its Cloudflare provider and state backend from `@alchemy.run/cloudflare` at the same release, so `state:check` loads on Effect 4.0.7 again. Each stack imports the provider from `@alchemy.run/cloudflare`; the D1 import and asset upload patch moves onto it. `state:bootstrap` runs `alchemy state bootstrap --backend cloudflare`, and both state scripts set `CI=true`.
