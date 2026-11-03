---
"@shared/infra": patch
"@musubi/infra": patch
"@pulse/infra": patch
"@zap/infra": patch
---

Alchemy moves to `2.0.0-beta.84`, with its Cloudflare provider and state backend from `@alchemy.run/cloudflare` at the same release, so `state:check` loads on Effect 4.0.7 again. Each stack imports the provider from `@alchemy.run/cloudflare`; the D1 import and asset upload patch moves onto it. `state:bootstrap` runs `alchemy state bootstrap --backend cloudflare`. Every Alchemy script, the state scripts and each stack's `plan:*` and `deploy:*`, sets `CI=true`, so a run by hand takes Cloudflare credentials from the environment alone and a plan never deploys a missing state store. `@shared/infra`'s tests check that the CLI imports exactly one provider package and that the lockfile holds none of the barred Alchemy packages, and the state CLI test runs as its own task, `test:alchemy`.
