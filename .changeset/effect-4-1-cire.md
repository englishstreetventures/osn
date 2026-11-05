---
"@cire/api": patch
"@cire/db": patch
"@cire/infra": patch
---

The cire API, database package and stack run `effect` 4.1.2 (`@cire/infra`
with `@effect/platform-bun` and `@effect/platform-node` 4.1.2). The cire
stack's `plan:guard` refuses a portal Worker giving up any host but its current
spare host unless `unflip` names the site.
