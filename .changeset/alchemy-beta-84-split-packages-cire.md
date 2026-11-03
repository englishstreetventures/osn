---
"@cire/infra": patch
---

The cire stack runs on Alchemy `2.0.0-beta.84` and imports its Cloudflare resources and Worker bundler from `@alchemy.run/cloudflare`. Its `plan:*` and `deploy:*` scripts set `CI=true`, so a run by hand takes Cloudflare credentials from the environment alone and a plan never deploys a missing state store.
