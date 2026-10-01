---
"@cire/api": patch
"@tools/oxlint-house": patch
---

`@cire/api`: every `WEB_ORIGIN` entry must now be an exact origin over
`https://`; `http://localhost` is accepted only outside a deployed tier, the 503
names a bad entry by position, and the cron digest skips itself on the same
failure. The image serve warnings log the slot kind instead of the cache slot,
which carried the wedding slug.

`@tools/oxlint-house`: new `no-module-scope-process-env` rule, on for
`cire/api/src/**`, reporting a `process.env` read that runs while a Worker
module loads.
