---
"@cire/infra": minor
"@cire/api": patch
"@cire/db": patch
"@cire/build-tools": patch
---

The cire stack builds cire's dev tier in its own Cloudflare account: cire-api with its database, seeds and buckets, cire-invites from its Astro build, and the host, vendor and landing sites as static-assets Workers, each with version preview URLs off. cire-api's `[env.dev]` Wrangler block and cire/db's `db:migrate:dev`, `db:seed:dev` and `db:reset:dev` are gone with the nightly rebuild; the D1 latency probe takes its origin from the dev hosts. Production configs are unchanged.
