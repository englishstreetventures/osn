---
"@cire/infra": patch
"@cire/invites": patch
---

The cire stack stages the guest site's Astro server output before uploading it, so cire-invites on dev carries its source maps as production's Wrangler deploy does, and a staging refusal leaves no file behind. cire-invites takes one observability value on every tier, `GUEST_OBSERVABILITY`, held equal to the block `cire/invites/wrangler.jsonc` deploys to production. That file's comment now says dev runs the same block.
